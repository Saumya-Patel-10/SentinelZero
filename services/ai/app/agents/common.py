"""Shared machinery for the single agent and the orchestrated sub-agents.

* ``RunBudget`` holds the run-wide bounds (provider steps, tool calls, context
  characters, deadline).  One instance exists per run and is shared by every
  sub-agent, so the bounds apply to the whole run, never per sub-agent.
* ``run_tool_loop`` is one bounded tool loop: model turn -> allowlisted tool
  execution -> follow-up, until the model returns final content.
* ``finish_run`` / ``fail_run`` are the only paths that persist an outcome: a
  single PENDING ``agent_submit_recommendation`` followed by
  ``agent_complete_run``, or ``agent_complete_run(FAILED)`` with no submission.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.backend import BackendClient
from app.config import Settings
from app.errors import (
    AI_CONTEXT_LIMIT,
    AI_DEADLINE_EXCEEDED,
    AI_OUTPUT_INVALID,
    AI_STEP_LIMIT,
    AI_TOOL_CALL_LIMIT,
    AI_TOOL_NOT_ALLOWED,
    AI_TOOL_USE_REQUIRED,
    AgentCancelled,
    AgentRunError,
)
from app.llm.types import ModelProvider, ProviderError
from app.schemas import (
    ProviderCallRecord,
    Recommendation,
    RecommendationDraft,
    RunRecord,
    ToolCallRecord,
)
from app.tools.registry import ToolContext, ToolRegistry

logger = logging.getLogger("sentinelzero.ai.agent")

_SAFE_MESSAGE = re.compile(r"[\r\n\t]+")
_CLIENT_KEY_UNSAFE = re.compile(r"[^A-Za-z0-9._:-]")


def now() -> datetime:
    return datetime.now(timezone.utc)


def safe_error(message: str) -> str:
    cleaned = _SAFE_MESSAGE.sub(" ", message or "Analysis failed safely.").strip()
    return cleaned[:300]


# Map internal failure codes onto the backend's AGENT_ERROR_CATEGORIES enum
# (packages/shared/src/enums.ts); agent_complete_run rejects anything else.
_BACKEND_CATEGORY = {
    "AI_PROVIDER_TIMEOUT": "TIMEOUT",
    "AI_DEADLINE_EXCEEDED": "TIMEOUT",
    "AI_PROVIDER_RATE_LIMITED": "RATE_LIMITED",
    "AI_PROVIDER_UNAVAILABLE": "PROVIDER_OUTAGE",
    "AI_PROVIDER_AUTH_FAILED": "PROVIDER_OUTAGE",
    "AI_PROVIDER_NOT_CONFIGURED": "PROVIDER_OUTAGE",
    "AI_PROVIDER_PROTOCOL_ERROR": "PROVIDER_OUTAGE",
    "AI_OUTPUT_INVALID": "VALIDATION_FAILED",
    "AI_TOOL_NOT_ALLOWED": "UNSUPPORTED_TOOL",
    "AI_TOOL_ARGUMENTS_INVALID": "UNSUPPORTED_TOOL",
    "AI_TOOL_USE_REQUIRED": "VALIDATION_FAILED",
    "AI_STEP_LIMIT": "VALIDATION_FAILED",
    "AI_TOOL_CALL_LIMIT": "VALIDATION_FAILED",
    "AI_CONTEXT_LIMIT": "VALIDATION_FAILED",
    "AI_CANCELLED": "CANCELLED",
}


def backend_error_category(code: str) -> str:
    return _BACKEND_CATEGORY.get(code, "INTERNAL")


def argument_keys(arguments_json: str) -> list[str]:
    try:
        parsed = json.loads(arguments_json or "{}")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, dict):
        return []
    return sorted(str(key)[:40] for key in parsed)[:20]


def message_chars(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content)
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list):
            total += len(json.dumps(tool_calls))
    return total


@dataclass
class RunBudget:
    """Run-wide bounds shared by every (sub-)agent of one run."""

    max_steps: int
    max_tool_calls: int
    max_context_chars: int
    deadline: float
    steps_used: int = 0
    tool_calls_used: int = 0
    context_chars_committed: int = 0

    @classmethod
    def from_settings(cls, settings: Settings) -> "RunBudget":
        return cls(
            max_steps=settings.max_steps,
            max_tool_calls=settings.max_tool_calls,
            max_context_chars=settings.max_context_chars,
            deadline=time.monotonic() + settings.run_deadline_seconds,
        )

    def check_deadline(self) -> None:
        if time.monotonic() >= self.deadline:
            raise AgentRunError(AI_DEADLINE_EXCEEDED, "Analysis deadline was exceeded.")

    def take_step(self) -> int:
        if self.steps_used >= self.max_steps:
            raise AgentRunError(
                AI_STEP_LIMIT, "The model did not produce a final result within the step bound."
            )
        self.steps_used += 1
        return self.steps_used

    def take_tool_call(self) -> None:
        if self.tool_calls_used >= self.max_tool_calls:
            raise AgentRunError(AI_TOOL_CALL_LIMIT, "The analysis exceeded the tool-call bound.")
        self.tool_calls_used += 1

    def check_context(self, current_chars: int) -> None:
        if self.context_chars_committed + current_chars > self.max_context_chars:
            raise AgentRunError(
                AI_CONTEXT_LIMIT, "The analysis context exceeded the configured bound."
            )

    def commit_context(self, chars: int) -> None:
        self.context_chars_committed += chars


@dataclass
class LoopResult:
    final_content: str
    tools_called: list[str] = field(default_factory=list)
    provider_calls: int = 0
    tool_calls: int = 0
    latency_ms: int = 0
    context_chars: int = 0


async def run_tool_loop(
    *,
    run_id: str,
    provider: ModelProvider,
    registry: ToolRegistry,
    store: Any,
    ctx: ToolContext,
    budget: RunBudget,
    messages: list[dict[str, Any]],
    tool_definitions: list[dict[str, Any]],
    allowed_tools: frozenset[str] | None,
    response_format: dict[str, Any] | None,
    require_tool_round_trip: bool,
    subagent: str | None = None,
) -> LoopResult:
    """Run one bounded tool loop until the model returns final content.

    ``allowed_tools`` narrows the global allowlist (sub-agents).  Only the tools
    in it are advertised to the model, and a call to anything else is recorded
    as DENIED and fails the run.  The response format is requested only after a
    tool round (or immediately when the loop offers no tools).
    """
    started_loop = time.monotonic()
    result = LoopResult(final_content="")
    read_tools_called: set[str] = set()
    cancel_event = ctx.cancel_event

    while True:
        if cancel_event.is_set():
            raise AgentCancelled()
        budget.check_deadline()
        step = budget.take_step()
        budget.check_context(message_chars(messages))

        want_format = response_format is not None and (
            not tool_definitions or bool(read_tools_called) or not require_tool_round_trip
        )
        started = time.monotonic()
        try:
            turn = await provider.complete(
                messages=messages,
                tools=tool_definitions,
                response_format=response_format if want_format else None,
                deadline=budget.deadline,
                cancel_event=cancel_event,
            )
        except AgentRunError:
            raise
        except ProviderError as exc:
            await store.add_provider_call(
                run_id,
                ProviderCallRecord(
                    step=step,
                    model_identifier=provider.descriptor.model_identifier[:120],
                    endpoint_class=provider.descriptor.endpoint_class[:60],
                    status="ERROR",
                    latency_ms=int((time.monotonic() - started) * 1000),
                    subagent=subagent,
                ),
            )
            raise AgentRunError(exc.category, exc.message) from exc

        result.provider_calls += 1
        await store.add_provider_call(
            run_id,
            ProviderCallRecord(
                step=step,
                model_identifier=(turn.model_identifier or provider.descriptor.model_identifier)[:120],
                endpoint_class=provider.descriptor.endpoint_class[:60],
                status="OK",
                latency_ms=max(0, int(turn.latency_ms)),
                finish_reason=(turn.finish_reason or None) and turn.finish_reason[:40],
                tool_calls=len(turn.tool_calls),
                input_tokens=turn.usage.get("input_tokens"),
                output_tokens=turn.usage.get("output_tokens"),
                subagent=subagent,
            ),
        )

        assistant_message: dict[str, Any] = {"role": "assistant", "content": turn.content}
        if turn.tool_calls:
            assistant_message["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments_json},
                }
                for call in turn.tool_calls
            ]
        messages.append(assistant_message)

        if not turn.tool_calls:
            if require_tool_round_trip and tool_definitions and not read_tools_called:
                raise AgentRunError(
                    AI_TOOL_USE_REQUIRED,
                    "The model did not perform the required read-only tool round trip.",
                )
            result.final_content = turn.content or ""
            break

        for call in turn.tool_calls:
            if cancel_event.is_set():
                raise AgentCancelled()
            budget.take_tool_call()
            result.tool_calls += 1
            try:
                execution = await registry.execute(ctx, call, allowed=allowed_tools)
            except AgentRunError as exc:
                await store.add_tool_call(
                    run_id,
                    ToolCallRecord(
                        id=(call.id or "call")[:160],
                        tool_name=call.name[:60],
                        input_summary={"argument_keys": argument_keys(call.arguments_json)},
                        output_summary={},
                        status="DENIED" if exc.code == AI_TOOL_NOT_ALLOWED else "ERROR",
                        timestamp=now(),
                        duration_ms=0,
                        subagent=subagent,
                    ),
                )
                raise
            await store.add_tool_call(
                run_id,
                ToolCallRecord(
                    id=(call.id or "call")[:160],
                    tool_name=call.name[:60],
                    input_summary={"argument_keys": argument_keys(call.arguments_json)},
                    output_summary=execution.output_summary,
                    status="OK",
                    timestamp=now(),
                    duration_ms=execution.duration_ms,
                    subagent=subagent,
                ),
            )
            if call.name != "propose_task":
                read_tools_called.add(call.name)
            result.tools_called.append(call.name)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "name": call.name,
                    "content": json.dumps(execution.payload, sort_keys=True, separators=(",", ":")),
                }
            )
        budget.check_context(message_chars(messages))

    result.context_chars = message_chars(messages)
    result.latency_ms = int((time.monotonic() - started_loop) * 1000)
    return result


# ---------------------------------------------------------------------------
# Outcome persistence
# ---------------------------------------------------------------------------


def build_recommendation(record: RunRecord, draft: RecommendationDraft) -> Recommendation:
    rec_id = f"rec_{hashlib.sha256(record.run_id.encode()).hexdigest()[:20]}"
    action_lines = [
        f"- [{action.priority}] {action.title}: {action.description}"
        for action in draft.proposed_actions
    ]
    description = draft.description
    if action_lines:
        description += "\n\nProposed actions (PENDING human approval):\n" + "\n".join(action_lines)
    evidence_ids = sorted(
        {eid for fact in draft.facts for eid in fact.evidence_ids}
        | {eid for action in draft.proposed_actions for eid in action.evidence_ids}
    )[:20]
    return Recommendation(
        id=rec_id,
        run_id=record.run_id,
        incident_id=record.incident_id,
        organization_id=record.organization_id,
        agent_run_id=record.run_id,
        title=draft.title[:160],
        description=description[:5000],
        priority=draft.priority,
        rationale=draft.rationale[:600],
        inference_mode=record.inference_mode,
        model_identifier=record.model_identifier,
        status="PENDING",
        evidence_ids=evidence_ids,
        facts=draft.facts,
        uncertainties=draft.uncertainties,
        proposed_actions=draft.proposed_actions,
        created_at=now(),
    )


def client_key_for(run_id: str, recommendation: Recommendation) -> str:
    raw = f"rec:{run_id}:{recommendation.id[-12:]}"
    return _CLIENT_KEY_UNSAFE.sub("_", raw)[:128]


async def finish_run(
    *,
    backend: BackendClient,
    store: Any,
    record: RunRecord,
    draft: RecommendationDraft,
    ctx: ToolContext,
    summary: str,
) -> Recommendation:
    """Submit exactly one PENDING recommendation, then complete the run."""
    recommendation = build_recommendation(record, draft)
    uncertainties = [u.question[:500] for u in draft.uncertainties][:20]
    if not recommendation.evidence_ids and not uncertainties:
        raise AgentRunError(
            AI_OUTPUT_INVALID, "A recommendation must cite evidence or state its uncertainties."
        )
    if ctx.cancel_event.is_set():
        raise AgentCancelled()
    await backend.agent_submit_recommendation(
        run_id=record.run_id,
        client_key=client_key_for(record.run_id, recommendation),
        title=recommendation.title,
        description=recommendation.description,
        priority=recommendation.priority,
        rationale=recommendation.rationale,
        evidence_ids=recommendation.evidence_ids,
        uncertainties=uncertainties,
    )
    await backend.agent_complete_run(
        run_id=record.run_id, status="COMPLETED", error_category="NONE", summary=summary[:5000]
    )
    await store.complete(
        record.run_id,
        recommendation,
        injection_suspected=bool(ctx.injection_categories),
        redaction_counts=ctx.redaction_counts,
        summary=summary,
    )
    return recommendation


async def fail_run(*, backend: BackendClient, store: Any, run_id: str, code: str, message: str) -> None:
    """Record a safe failure locally and in SpacetimeDB. Never submits anything."""
    await store.fail(run_id, code, safe_error(message))
    try:
        await backend.agent_complete_run(
            run_id=run_id,
            status="FAILED",
            error_category=backend_error_category(code),
            summary="Analysis failed safely. Manual workflows remain available.",
        )
    except Exception:
        logger.warning("agent_complete_run_failed run_id=%s category=%s", run_id, code)
