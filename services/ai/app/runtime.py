"""Application runtime: provider/backend selection, bounded background runs.

The runtime claims a run in SpacetimeDB (agent_claim_run), executes the bounded
agent loop using the service-principal backend, submits a PENDING recommendation
(agent_submit_recommendation), and marks the run terminal
(agent_complete_run).  All persistence lives in SpacetimeDB; the in-memory store
only tracks active runs for cancellation.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import secrets
from datetime import datetime, timezone

from app.auth import RunAccess, require_authorized
from app.backend import BackendClient, assert_pending_only
from app.config import Settings
from app.llm.types import ModelProvider
from app.schemas import (
    AnalysisAccepted,
    AnalysisRequest,
    FactDraft,
    InferenceMode,
    ProposedActionDraft,
    Recommendation,
    RecommendationDraft,
    RunRecord,
    RunStatus,
    ToolCallRecord,
    UncertaintyDraft,
)
from app.security.rate_limit import ConcurrentRunLimiter, RateLimiter
from app.store import RunStore

logger = logging.getLogger("sentinelzero.ai.runtime")

AGENT_ERROR_CATEGORIES = {
    "NONE",
    "INVALID_JSON",
    "PROVIDER_OUTAGE",
    "RATE_LIMITED",
    "TIMEOUT",
    "UNSUPPORTED_TOOL",
    "VALIDATION_FAILED",
    "CANCELLED",
    "INTERNAL",
}


class AppRuntime:
    def __init__(
        self,
        *,
        settings: Settings,
        backend: BackendClient,
        provider: ModelProvider,
        store: RunStore,
    ) -> None:
        self.settings = settings
        self.backend = backend
        self.provider = provider
        self.store = store
        self.rate_limiter = RateLimiter(
            per_minute=settings.rate_limit_per_minute,
            burst=settings.rate_limit_burst,
        )
        self.concurrency = ConcurrentRunLimiter(settings.max_concurrent_runs_per_user)
        self._tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------------
    # Run lifecycle
    # ------------------------------------------------------------------

    async def start(
        self,
        record: RunRecord,
        access: RunAccess,
        concurrency_key: str,
    ) -> None:
        """Claim the run in SpacetimeDB and start the background agent loop."""
        # Claim the run: transitions REQUESTED -> RUNNING with a 15-minute lease.
        await self.backend.agent_claim_run(
            run_id=record.run_id,
            model_identifier=record.model_identifier,
            inference_mode=record.inference_mode,
        )

        task = asyncio.create_task(
            self._run(record.run_id, access),
            name=f"agent-run:{record.run_id}",
        )
        self._tasks[record.run_id] = task
        task.add_done_callback(
            functools.partial(
                self._on_task_done,
                run_id=record.run_id,
                concurrency_key=concurrency_key,
            )
        )
        await self.store.attach_task(record.run_id, task)

    def _on_task_done(
        self, _task: asyncio.Task, *, run_id: str, concurrency_key: str
    ) -> None:
        """Release the per-user slot from a done callback.

        A ``finally`` block inside ``_run`` would never run if the task is
        cancelled before its coroutine starts, leaking the slot.
        """
        self._tasks.pop(run_id, None)
        try:
            asyncio.create_task(self.concurrency.release(concurrency_key))
        except RuntimeError:  # event loop shutting down
            pass

    async def _run(self, run_id: str, access: RunAccess) -> None:
        try:
            from app.agents.incident_agent import IncidentAgent

            agent = IncidentAgent(
                settings=self.settings,
                backend=self.backend,
                provider=self.provider,
                store=self.store,
            )
            await agent.run(run_id, access)
        except asyncio.CancelledError:
            await self.store.mark_cancelled(run_id)
            try:
                await self.backend.agent_complete_run(
                    run_id=run_id,
                    status="CANCELLED",
                    error_category="CANCELLED",
                    summary="Run cancelled by user.",
                )
            except Exception:
                logger.exception("runtime_cancel_complete_failed run_id=%s", run_id)
        except Exception:
            logger.exception("runtime_agent_crash run_id=%s", run_id)
            try:
                await self.store.fail(run_id, "INTERNAL_ERROR", "Analysis failed safely.")
                await self.backend.agent_complete_run(
                    run_id=run_id,
                    status="FAILED",
                    error_category="INTERNAL",
                    summary="Analysis failed safely. Manual workflows remain available.",
                )
            except Exception:
                logger.exception("runtime_fail_complete_failed run_id=%s", run_id)

    async def cancel(self, run_id: str) -> None:
        state = await self.store.get_state(run_id)
        if state is None:
            return
        try:
            await self.backend.agent_complete_run(
                run_id=run_id,
                status="CANCELLED",
                error_category="CANCELLED",
                summary="Run cancelled by user.",
            )
        except Exception:
            logger.exception("runtime_cancel_backend_failed run_id=%s", run_id)
        state.cancel_event.set()
        task = state.task or self._tasks.get(run_id)
        if task and not task.done():
            task.cancel()

    async def aclose(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.provider.aclose()
        await self.backend.aclose()

    # ------------------------------------------------------------------
    # Acceptance response
    # ------------------------------------------------------------------

    def analysis_accepted(self, record: RunRecord) -> AnalysisAccepted:
        return AnalysisAccepted(
            run_id=record.run_id,
            status=record.status,
            inference_mode=record.inference_mode,
            model_identifier=record.model_identifier,
        )


def make_provider(settings: Settings, provider_transport=None) -> ModelProvider:
    if settings.provider_mode == "scripted":
        from app.llm.scripted import ScriptedNemotronProvider

        return ScriptedNemotronProvider()
    from app.llm.nemotron_client import NemotronProvider

    return NemotronProvider(settings, transport=provider_transport)


def acceptance_notice(inference_mode: InferenceMode) -> str:
    if inference_mode == "LIVE":
        return "LIVE NVIDIA model inference. All proposals require human approval."
    if inference_mode == "SIMULATED":
        return "SIMULATED model output (not live inference). Proposals require human approval."
    return "Fixture or unverified provider output. Proposals require human approval."
