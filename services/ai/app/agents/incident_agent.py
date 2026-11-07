"""Bounded multi-step incident agent.

Loop: authenticate/authorize -> retrieve minimal incident header -> initial model
call -> validate tool requests -> execute allowlisted read tools -> follow-up ->
validate evidence-grounded JSON -> return a PENDING proposal bundle.

The agent has no capability to approve, execute, or persist a committed task.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

from app.auth import Principal
from app.backend import BackendClient, assert_pending_only
from app.config import Settings
from app.errors import (
    ACCESS_DENIED,
    AI_CONTEXT_LIMIT,
    AI_OUTPUT_INVALID,
    AI_STEP_LIMIT,
    AI_TOOL_CALL_LIMIT,
    AI_TOOL_USE_REQUIRED,
    AgentCancelled,
    AgentRunError,
)
from app.llm.prompts import SYSTEM_PROMPT, build_user_prompt, response_format
from app.llm.structured_output import (
    OutputValidationError,
    evidence_ids_used,
    extract_json_object,
    merge_tool_proposals,
    validate_against_evidence,
)
from app.llm.types import ModelProvider, ProviderError
from app.schemas import (
    ProposedTaskDraft,
    ProviderCallRecord,
    Recommendation,
    RecommendationDraft,
    RunRecord,
    ToolCallRecord,
)
from app.security.guardrails import scan_untrusted_text
from app.security.redaction import redact_text
from app.tools.registry import ToolContext, ToolRegistry
from app.tools.specs import TOOL_DEFINITIONS

logger = logging.getLogger("sentinelzero.ai.agent")

_SAFE_MESSAGE = re.compile(r"[\r\n\t]+")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_error(message: str) -> str:
    cleaned = _SAFE_MESSAGE.sub(" ", message or "Analysis failed safely.").strip()
    return cleaned[:300]


class IncidentAgent:
    def __init__(
        self,
        *,
        settings: Settings,
        backend: BackendClient,
        provider: ModelProvider,
        store: Any,
        registry: ToolRegistry | None = None,
    ) -> None:
        self.settings = settings
        self.backend = backend
        self.provider = provider
        self.store = store
        self.registry = registry or ToolRegistry()

    async def run(self, run_id: str, principal: Principal) -> None:
        state = await self.store.get_state(run_id)
        if state is None:
            return
        record: RunRecord = state.record
        cancel_event: asyncio.Event = state.cancel_event
        if cancel_event.is_set():
            await self.store.mark_cancelled(run_id)
            return

        await self.store.mark_running(run_id)
        deadline = time.monotonic() + self.settings.run_deadline_seconds

        try:
            decision = await self.backend.authorize_incident(
                principal, record.incident_id, "ai.analyze"
            )
            if not decision.allowed:
                raise AgentRunError(ACCESS_DENIED, "Incident access is no longer authorized.")

            incident = await self.backend.get_incident(record.incident_id)
            if (
                incident.organization_id != principal.organization_id
                or incident.id != record.incident_id
            ):
                raise AgentRunError(ACCESS_DENIED, "Incident scope check failed.")

            title, _ = redact_text(incident.title)
            description, redaction_counts = redact_text(incident.description)
            focus, focus_redactions = redact_text(record.focus or "")
            for key, value in focus_redactions.items():
                redaction_counts[key] = redaction_counts.get(key, 0) + value

            injection = scan_untrusted_text(f"{incident.title}\n{incident.description}\n{record.focus or ''}")
            exercise_label = incident.exercise_label or "EXERCISE"

            user_prompt = build_user_prompt(
                incident_id=incident.id,
                title=title[:160],
                description=description,
                category=incident.category,
                severity=incident.severity,
                status=incident.status,
                detected_at=incident.detected_at.isoformat(),
                reported_at=incident.reported_at.isoformat(),
                exercise_label=exercise_label,
                focus=focus or None,
                injection_scan=injection,
                redaction_counts=redaction_counts,
                max_context_chars=self.settings.max_context_chars,
            )
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ]

            ctx = ToolContext(
                backend=self.backend,
                incident_id=incident.id,
                organization_id=incident.organization_id,
                run_id=run_id,
                exercise_label=exercise_label,
                deadline=deadline,
                cancel_event=cancel_event,
                max_result_chars=self.settings.max_tool_result_chars,
                backend_timeout_seconds=self.settings.backend_timeout_seconds,
            )

            total_tool_calls = 0
            final_content: str | None = None

            for step in range(1, self.settings.max_steps + 1):
                if cancel_event.is_set():
                    raise AgentCancelled()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AgentRunError(AI_STEP_LIMIT, "Analysis deadline was exceeded.")

                started = time.monotonic()
                try:
                    turn = await self.provider.complete(
                        messages=messages,
                        tools=TOOL_DEFINITIONS,
                        response_format=response_format() if self._has_tool_round(ctx) else None,
                        deadline=deadline,
                        cancel_event=cancel_event,
                    )
                except AgentCancelled:
                    raise
                except ProviderError as exc:
                    await self.store.add_provider_call(
                        run_id,
                        ProviderCallRecord(
                            step=step,
                            model_identifier=self.provider.descriptor.model_identifier,
                            endpoint_class=self.provider.descriptor.endpoint_class,
                            status="ERROR",
                            latency_ms=int((time.monotonic() - started) * 1000),
                        ),
                    )
                    raise AgentRunError(exc.category, exc.message) from exc

                await self.store.add_provider_call(
                    run_id,
                    ProviderCallRecord(
                        step=step,
                        model_identifier=turn.model_identifier
                        or self.provider.descriptor.model_identifier,
                        endpoint_class=self.provider.descriptor.endpoint_class,
                        status="OK",
                        latency_ms=turn.latency_ms,
                        finish_reason=turn.finish_reason,
                        tool_calls=len(turn.tool_calls),
                        input_tokens=turn.usage.get("input_tokens"),
                        output_tokens=turn.usage.get("output_tokens"),
                    ),
                )

                assistant_message: dict[str, Any] = {
                    "role": "assistant",
                    "content": turn.content,
                }
                if turn.tool_calls:
                    assistant_message["tool_calls"] = [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments_json,
                            },
                        }
                        for call in turn.tool_calls
                    ]
                messages.append(assistant_message)

                if turn.tool_calls:
                    for call in turn.tool_calls:
                        if total_tool_calls >= self.settings.max_tool_calls:
                            raise AgentRunError(
                                AI_TOOL_CALL_LIMIT,
                                "The analysis exceeded the tool-call bound.",
                            )
                        if cancel_event.is_set():
                            raise AgentCancelled()
                        total_tool_calls += 1
                        try:
                            execution = await self.registry.execute(ctx, call)
                        except AgentRunError as exc:
                            await self.store.add_tool_call(
                                run_id,
                                ToolCallRecord(
                                    id=call.id,
                                    tool_name=call.name[:60],
                                    input_summary={
                                        "argument_keys": sorted(
                                            self._argument_keys(call.arguments_json)
                                        )
                                    },
                                    output_summary={},
                                    status="DENIED"
                                    if exc.code == "AI_TOOL_NOT_ALLOWED"
                                    else "ERROR",
                                    timestamp=_now(),
                                    duration_ms=0,
                                ),
                            )
                            raise
                        await self.store.add_tool_call(
                            run_id,
                            ToolCallRecord(
                                id=call.id,
                                tool_name=call.name[:60],
                                input_summary={
                                    "argument_keys": sorted(
                                        self._argument_keys(call.arguments_json)
                                    )
                                },
                                output_summary=execution.output_summary,
                                status="OK",
                                timestamp=_now(),
                                duration_ms=execution.duration_ms,
                            ),
                        )
                        tool_content = json.dumps(
                            execution.payload, sort_keys=True, separators=(",", ":")
                        )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.id,
                                "name": call.name,
                                "content": tool_content,
                            }
                        )
                    if self._message_chars(messages) > self.settings.max_context_chars:
                        raise AgentRunError(
                            AI_CONTEXT_LIMIT,
                            "The analysis context exceeded the configured bound.",
                        )
                    continue

                final_content = turn.content
                break

            if final_content is None:
                raise AgentRunError(
                    AI_STEP_LIMIT, "The model did not produce a final recommendation in bounds."
                )
            if self.settings.require_tool_round_trip and not ctx.read_tools_called:
                raise AgentRunError(
                    AI_TOOL_USE_REQUIRED,
                    "The model did not perform the required read-only tool round trip.",
                )

            draft = self._parse_draft(final_content)
            draft = validate_against_evidence(
                draft, allowed_evidence_ids=ctx.allowed_evidence_ids
            )
            tool_proposals = self._validate_tool_proposals(ctx)
            draft = merge_tool_proposals(draft, tool_proposals)

            recommendation = Recommendation(
                recommendation_id=f"rec_{run_id.removeprefix('run_')[:20]}",
                run_id=run_id,
                incident_id=incident.id,
                organization_id=incident.organization_id,
                created_at=_now(),
                model_identifier=self.provider.descriptor.model_identifier,
                provider_mode=self.provider.descriptor.mode,
                inference_label=self.provider.descriptor.inference_label,
                approval_status="PENDING_HUMAN_APPROVAL",
                exercise_label=exercise_label,
                summary=draft.summary,
                facts=draft.facts,
                uncertainties=draft.uncertainties,
                proposed_tasks=draft.proposed_tasks,
                limitations=draft.limitations,
                evidence_ids_used=evidence_ids_used(draft),
                injection_suspected=injection.suspected or bool(ctx.injection_categories),
                redaction_counts={**redaction_counts, **ctx.redaction_counts},
            )
            assert_pending_only(recommendation)
            if cancel_event.is_set():
                raise AgentCancelled()
            await self.store.complete(run_id, recommendation)
            logger.info(
                "agent_run_complete run_id=%s tool_calls=%s facts=%s tasks=%s pending=true",
                run_id,
                total_tool_calls,
                len(recommendation.facts),
                len(recommendation.proposed_tasks),
            )
        except AgentCancelled:
            await self.store.mark_cancelled(run_id)
        except AgentRunError as exc:
            await self.store.fail(run_id, exc.code, _safe_error(exc.message))
            logger.warning("agent_run_failed run_id=%s category=%s", run_id, exc.code)
        except asyncio.CancelledError:
            await self.store.mark_cancelled(run_id)
            raise
        except Exception:
            await self.store.fail(
                run_id, "INTERNAL_ERROR", "Analysis failed safely. Manual workflows remain available."
            )
            logger.exception("agent_run_internal_error run_id=%s", run_id)

    def _has_tool_round(self, ctx: ToolContext) -> bool:
        return bool(ctx.read_tools_called)

    @staticmethod
    def _argument_keys(arguments_json: str) -> set[str]:
        try:
            parsed = json.loads(arguments_json or "{}")
        except json.JSONDecodeError:
            return set()
        return set(parsed) if isinstance(parsed, dict) else set()

    @staticmethod
    def _message_chars(messages: list[dict[str, Any]]) -> int:
        total = 0
        for message in messages:
            content = message.get("content")
            if isinstance(content, str):
                total += len(content)
            tool_calls = message.get("tool_calls")
            if isinstance(tool_calls, list):
                total += len(json.dumps(tool_calls))
        return total

    @staticmethod
    def _parse_draft(content: str) -> RecommendationDraft:
        payload = extract_json_object(content)
        try:
            return RecommendationDraft.model_validate(payload)
        except Exception as exc:  # pydantic ValidationError -> typed safe failure
            raise OutputValidationError(
                "Model output did not match the required recommendation schema."
            ) from exc

    @staticmethod
    def _validate_tool_proposals(ctx: ToolContext) -> list[ProposedTaskDraft]:
        validated: list[ProposedTaskDraft] = []
        for proposal in ctx.proposals:
            if any(eid not in ctx.allowed_evidence_ids for eid in proposal.evidence_ids):
                raise AgentRunError(
                    AI_OUTPUT_INVALID,
                    "A tool proposal cited evidence that was not authorized.",
                )
            validated.append(proposal)
        return validated
