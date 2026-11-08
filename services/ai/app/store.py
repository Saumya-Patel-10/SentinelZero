"""In-process, bounded run store for active agent runs.

Persistence is owned by SpacetimeDB (agent_run / agent_tool_call /
recommendation tables). This store only tracks active runs for cancellation
and in-flight status. It never stores prompts, raw provider responses,
approvals, or secrets.
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
    SubagentRecord,
    ToolCallRecord,
)

TERMINAL = frozenset({"COMPLETED", "FAILED", "CANCELLED", "EXPIRED"})


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class RunState:
    record: RunRecord
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


def _replace(record: RunRecord, **updates: object) -> RunRecord:
    payload = record.model_dump()
    payload.update(updates)
    return RunRecord.model_validate(payload)


def _settle_subagents(record: RunRecord) -> list[SubagentRecord]:
    """A run that ends early never leaves a sub-agent looking active."""
    settled = []
    for item in record.subagents:
        if item.status == "RUNNING":
            item = item.model_copy(update={"status": "FAILED"})
        elif item.status == "PENDING":
            item = item.model_copy(update={"status": "SKIPPED"})
        settled.append(item)
    return settled


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

    async def create_if_absent(self, record: RunRecord) -> bool:
        """Atomically create a run; False if this run id is already tracked."""
        async with self._lock:
            self._prune_locked()
            if record.run_id in self._states:
                return False
            if len(self._states) >= self._max_runs:
                self._drop_oldest_terminal_locked()
            if len(self._states) >= self._max_runs:
                from app.errors import SERVICE_UNAVAILABLE, ApiError

                raise ApiError(
                    503, SERVICE_UNAVAILABLE, "The AI service is at capacity. Retry later.",
                    headers={"Retry-After": "30"},
                )
            self._states[record.run_id] = RunState(record=record)
            return True

    async def discard(self, run_id: str) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is not None and state.task is None:
                self._states.pop(run_id, None)

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
            only_if=lambda record: record.status in {"REQUESTED", "QUEUED"},
        )

    async def add_provider_call(self, run_id: str, call: ProviderCallRecord) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return
            calls = [*state.record.provider_calls, call][:32]
            state.record = _replace(state.record, provider_calls=calls)

    async def add_tool_call(self, run_id: str, call: ToolCallRecord) -> None:
        async with self._lock:
            state = self._states.get(run_id)
            if state is None:
                return
            calls = [*state.record.tool_calls, call][:40]
            state.record = _replace(state.record, tool_calls=calls)

    async def update_subagent(self, run_id: str, subagent: SubagentRecord) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in TERMINAL:
                return record
            subagents = [
                subagent if item.name == subagent.name else item for item in record.subagents
            ]
            return _replace(record, subagents=subagents)

        await self._mutate(run_id, update)

    async def set_subagents(self, run_id: str, subagents: list[SubagentRecord]) -> None:
        await self._mutate(
            run_id,
            lambda record: _replace(record, subagents=subagents),
            only_if=lambda record: record.status not in TERMINAL,
        )

    async def set_sitrep(self, run_id: str, sitrep: str) -> None:
        await self._mutate(
            run_id,
            lambda record: _replace(record, sitrep=sitrep[:2000]),
            only_if=lambda record: record.status not in TERMINAL,
        )

    async def complete(
        self,
        run_id: str,
        recommendation: Recommendation,
        *,
        injection_suspected: bool = False,
        redaction_counts: dict[str, int] | None = None,
        summary: str = "",
    ) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in TERMINAL:
                return record
            return _replace(
                record,
                status="COMPLETED",
                finished_at=_now(),
                recommendation=recommendation,
                injection_suspected=injection_suspected,
                redaction_counts=dict(redaction_counts or {}),
                summary=summary[:5000],
            )

        await self._mutate(run_id, update)


    async def fail(self, run_id: str, code: str, message: str) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in TERMINAL:
                return record
            return _replace(
                record,
                status="FAILED",
                finished_at=_now(),
                error_category=code[:60],
                error_message=message[:300],
                subagents=_settle_subagents(record),
            )

        await self._mutate(run_id, update)

    async def mark_cancelled(self, run_id: str) -> None:
        def update(record: RunRecord) -> RunRecord:
            if record.status in TERMINAL:
                return record
            return _replace(
                record,
                status="CANCELLED",
                finished_at=_now(),
                subagents=_settle_subagents(record),
            )

        await self._mutate(run_id, update)

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
            if state.record.status in {"COMPLETED", "FAILED", "CANCELLED", "EXPIRED"}
        ]
        if terminal:
            _, run_id, _ = min(terminal, key=lambda item: item[0])
            self._states.pop(run_id, None)
