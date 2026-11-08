"""Bounded single-loop incident agent (``AI_AGENT_MODE=single``).

Loop: retrieve minimal incident header -> initial model call -> validate tool
requests -> execute allowlisted read tools -> follow-up -> validate
evidence-grounded JSON -> submit a PENDING recommendation -> complete the run.

The agent has no capability to approve, execute, or persist a committed task.
All writes go through ``agent_submit_recommendation`` (PENDING only) and
``agent_complete_run`` (terminal status).  A human commander approves or rejects
through the operational backend.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.agents.common import (
    RunBudget,
    fail_run,
    finish_run,
    run_tool_loop,
)
from app.auth import RunAccess
from app.backend import BackendClient
from app.config import Settings
from app.errors import AI_OUTPUT_INVALID, AgentCancelled, AgentRunError, ApiError
from app.llm.prompts import SYSTEM_PROMPT, build_user_prompt, response_format
from app.llm.structured_output import (
    OutputValidationError,
    extract_json_object,
    merge_tool_proposals,
    validate_against_evidence,
)
from app.llm.types import ModelProvider
from app.schemas import RecommendationDraft, RunRecord, initial_subagents
from app.security.guardrails import scan_untrusted_text
from app.security.redaction import redact_text
from app.tools.registry import ToolContext, ToolRegistry
from app.tools.specs import TOOL_DEFINITIONS

logger = logging.getLogger("sentinelzero.ai.agent")


def parse_draft(content: str) -> RecommendationDraft:
    payload = extract_json_object(content)
    try:
        return RecommendationDraft.model_validate(payload)
    except Exception as exc:
        raise OutputValidationError(
            "Model output did not match the required recommendation schema."
        ) from exc


def validate_tool_proposals(ctx: ToolContext) -> list:
    for proposal in ctx.proposals:
        if any(eid not in ctx.allowed_evidence_ids for eid in proposal.evidence_ids):
            raise AgentRunError(AI_OUTPUT_INVALID, "A tool proposal cited evidence that was not authorized.")
    return list(ctx.proposals)


async def prepare_run(agent: Any, run_id: str) -> tuple[RunRecord, asyncio.Event] | None:
    """Shared run preamble: load state, honour early cancel, mark RUNNING."""
    state = await agent.store.get_state(run_id)
    if state is None:
        return None
    if state.cancel_event.is_set():
        await agent.store.mark_cancelled(run_id)
        return None
    await agent.store.mark_running(run_id)
    return state.record, state.cancel_event


def make_context(
    agent: Any,
    record: RunRecord,
    incident_id: str,
    exercise_label: str,
    budget: RunBudget,
    cancel_event: asyncio.Event,
) -> ToolContext:
    return ToolContext(
        backend=agent.backend,
        incident_id=incident_id,
        organization_id=record.organization_id,
        run_id=record.run_id,
        exercise_label=exercise_label,
        deadline=budget.deadline,
        cancel_event=cancel_event,
        max_result_chars=agent.settings.max_tool_result_chars,
        backend_timeout_seconds=agent.settings.backend_timeout_seconds,
    )


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

    async def run(self, run_id: str, access: RunAccess) -> None:
        prepared = await prepare_run(self, run_id)
        if prepared is None:
            return
        record, cancel_event = prepared
        await self.store.set_subagents(run_id, initial_subagents("SKIPPED"))
        budget = RunBudget.from_settings(self.settings)

        try:
            incident = await self.backend.agent_get_incident(run_id)
            if incident.incident_id != record.incident_id:
                raise AgentRunError(AI_OUTPUT_INVALID, "Backend incident did not match the authorized run.")

            title, _ = redact_text(incident.title)
            description, redaction_counts = redact_text(incident.description)
            injection = scan_untrusted_text(f"{incident.title}\n{incident.description}")
            exercise_label = incident.data_class or "EXERCISE"

            user_prompt = build_user_prompt(
                incident_id=incident.incident_id,
                title=title[:160],
                description=description,
                category=incident.category,
                severity=incident.severity,
                status=incident.status,
                detected_at=incident.detected_at,
                reported_at=incident.reported_at,
                exercise_label=exercise_label,
                focus=None,
                injection_scan=injection,
                redaction_counts=redaction_counts,
                max_context_chars=self.settings.max_context_chars,
            )
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ]
            ctx = make_context(self, record, incident.incident_id, exercise_label, budget, cancel_event)
            if injection.suspected:
                ctx.injection_categories.update(injection.categories)

            loop = await run_tool_loop(
                run_id=run_id,
                provider=self.provider,
                registry=self.registry,
                store=self.store,
                ctx=ctx,
                budget=budget,
                messages=messages,
                tool_definitions=TOOL_DEFINITIONS,
                allowed_tools=None,
                response_format=response_format(),
                require_tool_round_trip=self.settings.require_tool_round_trip,
            )

            draft = parse_draft(loop.final_content)
            draft = validate_against_evidence(draft, allowed_evidence_ids=ctx.allowed_evidence_ids)
            draft = merge_tool_proposals(draft, validate_tool_proposals(ctx))

            await finish_run(
                backend=self.backend,
                store=self.store,
                record=record,
                draft=draft,
                ctx=ctx,
                summary=draft.description,
            )
            logger.info(
                "agent_run_complete run_id=%s mode=single tool_calls=%s actions=%s pending=true",
                run_id,
                budget.tool_calls_used,
                len(draft.proposed_actions),
            )
        except AgentCancelled:
            await self.store.mark_cancelled(run_id)
        except AgentRunError as exc:
            await fail_run(backend=self.backend, store=self.store, run_id=run_id, code=exc.code, message=exc.message)
            logger.warning("agent_run_failed run_id=%s category=%s", run_id, exc.code)
        except ApiError as exc:
            await fail_run(backend=self.backend, store=self.store, run_id=run_id, code="AI_BACKEND_REJECTED", message=exc.message)
            logger.warning("agent_run_backend_rejected run_id=%s code=%s", run_id, exc.code)
        except asyncio.CancelledError:
            await self.store.mark_cancelled(run_id)
            raise
        except Exception:
            logger.exception("agent_run_internal_error run_id=%s", run_id)
            await fail_run(
                backend=self.backend,
                store=self.store,
                run_id=run_id,
                code="INTERNAL_ERROR",
                message="Analysis failed safely. Manual workflows remain available.",
            )
