"""In-process, bounded run and submission store.

MOCK persistence: runs are intentionally ephemeral in this branch. Agent 1 owns the
canonical AgentRun/AgentToolCall tables. The backend contract for durable storage is
documented in docs/deployment.md. This store never stores prompts, raw provider
responses, approvals, or secrets.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from app.schemas import (
    ProviderCallRecord,
    Recommendation,
    RunRecord,
    SubmissionResult,
    ToolCallRecord,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class RunState:
    record: RunRecord
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    submissions: dict[str, SubmissionResult] = field(default_factory=dict)


def _replace(record: RunRecord, **updates: object) -> RunRecord:
    payload = record.model_dump()
    payload.update(updates)
    return RunRecord.model_validate(payload)


class RunStore:
    def __init__(self, *, ttl_seconds: int = 3_600, max_runs: int = 500) -> None:
        self._states: dict[str, RunState] = {}
        self._lock = asyncio.Lock()
        self._ttl = timedelta(seconds=ttl_seconds)
        self._max_runs = max_runs

    async def create(self, record: RunRecord) -> None:
        async with self._lock:
            self._prune_locked()
            if len(self._states) >= self._max_runs:
                self._drop_oldest_terminal_locked()
            self._states[record.run_id] = RunState(record=record)

    async def get_state(self, run_id: str) -> RunState | None:
        async with self._lock:
            self._prune_locked()
            return self._states.get(run_id)

    async def get(self, run_id: str) -> RunRecord | None:
        state = await self.get_state(run_id)
        return state.record if state else None

    async def attach_task(self, run_id: str, task: asyncio.Task) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state:
                state.task = task

    async def mark_running(self, run_id: str) -> None:
        await self._mutate(
            run_id,
            lambda record: _replace(record, status="RUNNING", started_at=record.started_at or _now()),
            only_if=lambda record: record.status == "QUEUED",
        )

    async def add_provider_call(self, run_id: str, call: ProviderCallRecord) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return
            calls = [*state.record.provider_calls, call][:16]
            state.record = _replace(state.record, provider_calls=calls)

    async def add_tool_call(self, run_id: str, call: ToolCallRecord) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return
            calls = [*state.record.tool_calls, call][:32]
            state.record = _replace(state.record, tool_calls=calls)

    async def complete(self, run_id: str, recommendation: Recommendation) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in {"CANCELLED", "FAILED", "COMPLETED"}:
                return record
            return _replace(
                record,
                status="COMPLETED",
                finished_at=_now(),
                recommendation=recommendation,
                injection_suspected=recommendation.injection_suspected,
                redaction_counts=recommendation.redaction_counts,
            )

        await self._mutate(run_id, update)

    async def fail(self, run_id: str, code: str, message: str) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in {"CANCELLED", "COMPLETED"}:
                return record
            return _replace(
                record,
                status="FAILED",
                finished_at=_now(),
                error_category=code[:60],
                error_message=message[:300],
            )

        await self._mutate(run_id, update)

    async def mark_cancelled(self, run_id: str) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in {"CANCELLED", "COMPLETED", "FAILED"}:
                return record
            return _replace(record, status="CANCELLED", finished_at=_now())

        await self._mutate(run_id, update)

    async def record_submission(self, run_id: str, result: SubmissionResult) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return
            state.submissions[result.recommendation_id] = result
            recommendation = state.record.recommendation
            if recommendation and recommendation.recommendation_id == result.recommendation_id:
                updated = recommendation.model_copy(
                    update={
                        "submitted": True,
                        "submitted_reference": result.backend_reference,
                    }
                )
                state.record = _replace(state.record, recommendation=updated)

    async def get_submission(self, run_id: str, recommendation_id: str) -> SubmissionResult | None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return None
            return state.submissions.get(recommendation_id)

    async def find_by_recommendation(self, recommendation_id: str) -> RunState | None:
        async with self._lock:
            for state in self._states.values():
                if (
                    state.record.recommendation
                    and state.record.recommendation.recommendation_id == recommendation_id
                ):
                    return state
            return None

    async def all_states(self) -> list[RunState]:
        async with self._lock:
            return list(self._states.values())

    async def _mutate(
        self,
        run_id: str,
        fn: Callable[[RunRecord], RunRecord],
        *,
        only_if: Callable[[RunRecord], bool] | None = None,
    ) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return
            if only_if is not None and not only_if(state.record):
                return
            state.record = fn(state.record)

    def _prune_locked(self) -> None:
        now = _now()
        stale = [
            run_id
            for run_id, state in self._states.items()
            if now - (state.record.finished_at or state.record.created_at) > self._ttl
        ]
        for run_id in stale:
            state = self._states.pop(run_id, None)
            if state and state.task and not state.task.done():
                state.task.cancel()

    def _drop_oldest_terminal_locked(self) -> None:
        terminal = [
            (state.record.finished_at or state.record.created_at, run_id, state)
            for run_id, state in self._states.items()
            if state.record.status in {"COMPLETED", "FAILED", "CANCELLED"}
        ]
        if terminal:
            _, run_id, _ = min(terminal, key=lambda item: item[0])
            self._states.pop(run_id, None)
