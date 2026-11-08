"""Run-store lifecycle, bounded retention, and terminal-state immutability."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.schemas import Recommendation, RunRecord
from app.store import RunStore

NOW = datetime.now(timezone.utc)


def _record(run_id: str, *, created_at: datetime = NOW) -> RunRecord:
    return RunRecord(
        run_id=run_id,
        organization_id="org_riverbend_001",
        incident_id="inc_riverbend_ransomware_001",
        requested_by="analyst@riverbend.exercise.invalid",
        requested_role="ANALYST",
        status="REQUESTED",
        inference_mode="SIMULATED",
        model_identifier="scripted-local-test-model",
        exercise_label="EXERCISE",
        created_at=created_at,
    )


def _recommendation(run_id: str) -> Recommendation:
    return Recommendation(
        id=f"rec_{run_id}",
        run_id=run_id,
        incident_id="inc_riverbend_ransomware_001",
        organization_id="org_riverbend_001",
        agent_run_id=run_id,
        title="Proposal-only test recommendation.",
        description="Synthetic exercise recommendation.",
        priority="P1",
        rationale="Preserve evidence.",
        inference_mode="SIMULATED",
        model_identifier="scripted-local-test-model",
        status="PENDING",
        created_at=NOW,
    )


async def test_create_and_read():
    store = RunStore()
    await store.create(_record("run_one"))

    state = await store.get_state("run_one")
    assert state is not None
    assert state.record.status == "REQUESTED"
    assert await store.get("missing") is None


async def test_mark_running_complete_and_terminal_is_immutable():
    store = RunStore()
    await store.create(_record("run_one"))
    await store.mark_running("run_one")
    state = await store.get_state("run_one")
    assert state.record.status == "RUNNING"
    assert state.record.started_at is not None

    await store.complete("run_one", _recommendation("run_one"))
    completed = await store.get("run_one")
    assert completed.status == "COMPLETED"
    assert completed.recommendation is not None

    await store.fail("run_one", "AI_OUTPUT_INVALID", "late failure")
    await store.mark_cancelled("run_one")
    still = await store.get("run_one")
    assert still.status == "COMPLETED"
    assert still.error_category is None


async def test_cancelled_run_is_not_overwritten_by_failure():
    store = RunStore()
    await store.create(_record("run_one"))
    await store.mark_cancelled("run_one")
    await store.fail("run_one", "INTERNAL_ERROR", "late")

    final = await store.get("run_one")
    assert final.status == "CANCELLED"
    assert final.error_category is None


async def test_ttl_prunes_old_runs():
    store = RunStore(ttl_seconds=0)
    await store.create(_record("run_one"))

    assert await store.get_state("run_one") is None


async def test_max_runs_drops_oldest_terminal_run():
    store = RunStore(max_runs=1)
    await store.create(_record("run_one", created_at=NOW - timedelta(minutes=5)))
    await store.mark_cancelled("run_one")
    await store.create(_record("run_two"))

    assert await store.get("run_one") is None
    assert await store.get("run_two") is not None
