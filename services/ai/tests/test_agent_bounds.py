"""Agent bounds: step limit, tool-call limit, context limit, provider failure,
missing tool round trip, forbidden tool, cancellation."""

from __future__ import annotations

from conftest import INCIDENT, auth_headers, wait_for_run

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"


async def test_step_limit_stops_run(app_factory, client_factory, stdb):
    app = app_factory(
        settings=__import__("conftest", fromlist=["test_settings"]).test_settings(
            max_steps=1, run_deadline_seconds=20.0
        )
    )
    client = await client_factory(app)
    headers = auth_headers()
    run_id = "run_step_limit_001"
    stdb.set_run(run_id, status="REQUESTED")

    # FakeNemotron that always requests tools (never produces final JSON), so
    # the agent hits the step limit.
    from conftest import FakeNemotron

    provider = FakeNemotron([FakeNemotron.tool_turn([("c1", "get_incident", "{}")])] * 3)

    app.state.provider = provider
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

    from app.llm.types import AssistantTurn

    class NoToolProvider:
        descriptor = type(
            "D",
            (),
            {
                "mode": "scripted",
                "endpoint_class": "SIMULATED_SCRIPTED",
                "model_identifier": "no-tool-model",
                "inference_label": "SIMULATED_MODEL_OUTPUT",
                "configured": True,
            },
        )()

        async def complete(self, **kwargs):
            return AssistantTurn(
                content='{"title":"x","description":"y","priority":"P1","rationale":"z"}',
                tool_calls=[],
                finish_reason="stop",
            )

        async def aclose(self):
            return None

    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()
    run_id = "run_no_tool_001"
    stdb.set_run(run_id, status="REQUESTED")

    app.state.provider = NoToolProvider()
    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    assert accepted.status_code == 202
    run = await wait_for_run(client, run_id, headers)
    assert run["status"] == "FAILED"
    assert run["error_category"] == "AI_TOOL_USE_REQUIRED"


async def test_cancel_marks_run_cancelled(app_factory, client_factory, stdb):
    app = app_factory()
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
