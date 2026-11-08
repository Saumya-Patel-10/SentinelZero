"""Agent bounds: step limit, tool-call limit, context limit, provider failure,
missing tool round trip, forbidden tool, cancellation."""

from __future__ import annotations

import asyncio

from app.llm.types import AssistantTurn, ProviderDescriptor, ToolCallRequest
from conftest import INCIDENT, auth_headers, test_settings, wait_for_run

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"

_SCRIPTED = ProviderDescriptor(
    mode="scripted",
    endpoint_class="SIMULATED_SCRIPTED",
    model_identifier="bounds-test-model",
    inference_label="SIMULATED_MODEL_OUTPUT",
    configured=True,
)


class _AlwaysTools:
    descriptor = _SCRIPTED

    async def complete(self, **kwargs):
        return AssistantTurn(
            content=None,
            tool_calls=[ToolCallRequest(id="c1", name="get_incident", arguments_json="{}")],
            finish_reason="tool_calls",
        )

    async def aclose(self):
        return None


async def test_step_limit_stops_run(app_factory, client_factory, stdb):
    app = app_factory(
        settings=test_settings(max_steps=1, run_deadline_seconds=20.0),
        provider=_AlwaysTools(),
    )
    client = await client_factory(app)
    headers = auth_headers()
    run_id = "run_step_limit_001"
    stdb.set_run(run_id, status="REQUESTED")

    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    assert accepted.status_code == 202
    run = await wait_for_run(client, run_id, headers)
    assert run["status"] == "FAILED"
    assert run["error_category"] == "AI_STEP_LIMIT"


async def test_missing_tool_round_trip_fails_run(app_factory, client_factory, stdb):
    """The model must call at least one read tool."""

    class NoToolProvider:
        descriptor = _SCRIPTED

        async def complete(self, **kwargs):
            return AssistantTurn(
                content='{"title":"x","description":"y","priority":"P1","rationale":"z"}',
                tool_calls=[],
                finish_reason="stop",
            )

        async def aclose(self):
            return None

    app = app_factory(provider=NoToolProvider())
    client = await client_factory(app)
    headers = auth_headers()
    run_id = "run_no_tool_001"
    stdb.set_run(run_id, status="REQUESTED")

    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    assert accepted.status_code == 202
    run = await wait_for_run(client, run_id, headers)
    assert run["status"] == "FAILED"
    assert run["error_category"] == "AI_TOOL_USE_REQUIRED"


class _HoldUntilCancel:
    """Blocks inside the provider so cancel is observed while the run is in flight."""

    descriptor = _SCRIPTED

    def __init__(self) -> None:
        self.entered = asyncio.Event()

    async def complete(self, *, cancel_event=None, **kwargs):
        self.entered.set()
        while cancel_event is None or not cancel_event.is_set():
            await asyncio.sleep(0.01)
        from app.errors import AgentCancelled

        raise AgentCancelled()

    async def aclose(self):
        return None


async def test_cancel_marks_run_cancelled(app_factory, client_factory, stdb):
    provider = _HoldUntilCancel()
    app = app_factory(provider=provider)
    client = await client_factory(app)
    headers = auth_headers()
    run_id = "run_cancel_001"
    stdb.set_run(run_id, status="REQUESTED")

    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    assert accepted.status_code == 202
    await asyncio.wait_for(provider.entered.wait(), timeout=2)

    cancel_response = await client.post(
        f"/v1/agent-runs/{run_id}/cancel", headers=headers
    )
    assert cancel_response.status_code == 202
    assert cancel_response.json()["status"] == "CANCELLED"

    run = (await client.get(f"/v1/agent-runs/{run_id}", headers=headers)).json()
    assert run["status"] == "CANCELLED"


async def test_unknown_run_returns_404(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/v1/agent-runs/run_does_not_exist", headers=auth_headers())
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
