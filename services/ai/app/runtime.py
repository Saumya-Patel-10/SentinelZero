"""Application runtime: provider/backend selection, bounded background runs."""

from __future__ import annotations

import asyncio
import functools
import logging

from app.agents.incident_agent import IncidentAgent
from app.auth import Principal
from app.backend import BackendClient
from app.config import Settings
from app.llm.types import ModelProvider
from app.schemas import AnalysisAccepted, RunRecord
from app.security.rate_limit import ConcurrentRunLimiter, RateLimiter
from app.store import RunStore

logger = logging.getLogger("sentinelzero.ai.runtime")


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
        self.agent = IncidentAgent(
            settings=settings, backend=backend, provider=provider, store=store
        )
        self.rate_limiter = RateLimiter(
            per_minute=settings.rate_limit_per_minute,
            burst=settings.rate_limit_burst,
        )
        self.concurrency = ConcurrentRunLimiter(settings.max_concurrent_runs_per_user)
        self._tasks: dict[str, asyncio.Task] = {}

    async def start(self, record: RunRecord, principal: Principal, concurrency_key: str) -> None:
        task = asyncio.create_task(
            self._run(record.run_id, principal),
            name=f"agent-run:{record.run_id}",
        )
        self._tasks[record.run_id] = task
        # Release the per-user slot from a done callback: if the task is cancelled
        # before its coroutine ever starts, a `finally` block inside `_run` would
        # never execute and the slot would leak.
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
        self._tasks.pop(run_id, None)
        try:
            asyncio.create_task(self.concurrency.release(concurrency_key))
        except RuntimeError:  # event loop shutting down
            pass

    async def _run(self, run_id: str, principal: Principal) -> None:
        try:
            await self.agent.run(run_id, principal)
        except asyncio.CancelledError:
            await self.store.mark_cancelled(run_id)
        except Exception:
            logger.exception("runtime_agent_crash run_id=%s", run_id)
            await self.store.fail(
                run_id,
                "INTERNAL_ERROR",
                "Analysis failed safely. Manual workflows remain available.",
            )

    async def cancel(self, run_id: str) -> None:
        state = await self.store.get_state(run_id)
        if state is None:
            return
        state.cancel_event.set()
        await self.store.mark_cancelled(run_id)
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


def make_provider(settings: Settings, provider_transport=None) -> ModelProvider:
    if settings.provider_mode == "scripted":
        from app.llm.scripted import ScriptedNemotronProvider

        return ScriptedNemotronProvider()
    from app.llm.nemotron_client import NemotronProvider

    return NemotronProvider(settings, transport=provider_transport)


def acceptance_notice(provider: ModelProvider) -> tuple[bool, str]:
    live = (
        provider.descriptor.configured
        and provider.descriptor.inference_label == "LIVE_NVIDIA_INFERENCE"
    )
    if live:
        return True, "LIVE NVIDIA model inference. All tasks remain PENDING human approval."
    if provider.descriptor.mode == "scripted":
        return False, "SIMULATED model output (not live inference). Proposals require human approval."
    if provider.descriptor.endpoint_class == "CUSTOM_OPENAI_COMPATIBLE":
        return False, (
            "Custom OpenAI-compatible endpoint; NVIDIA live inference is not attested. "
            "Proposals require human approval."
        )
    return False, "Model provider is not configured for live inference. Proposals require approval."


def analysis_accepted(record: RunRecord, provider: ModelProvider) -> AnalysisAccepted:
    live, notice = acceptance_notice(provider)
    return AnalysisAccepted(
        run_id=record.run_id,
        status=record.status,
        incident_id=record.incident_id,
        provider_mode=record.provider_mode,
        inference_label=record.inference_label,
        live_inference=live,
        exercise_label=record.exercise_label,
        notice=notice,
    )
