"""End-to-end scripted workflow: evidence, tool calls, bounded agent, proposals.

The browser first calls SpacetimeDB's request_agent_run reducer to create a
REQUESTED run, then calls FastAPI with the run id. The service verifies access
through verify_agent_run_access, claims the run, executes the bounded agent
loop, submits a PENDING recommendation, and completes the run.
"""

from __future__ import annotations

import json

from conftest import INCIDENT, ORG, auth_headers, wait_for_run

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"
READ_TOOLS = {
    "get_incident",
    "get_assets",
    "get_dependencies",
    "get_open_tasks",
    "get_evidence_summaries",
}


async def test_scripted_run_completes_with_tool_round_trip(app_factory, client_factory, stdb):
    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()

    run_id = "run_e2e_workflow_001"
    stdb.set_run(run_id, status="REQUESTED")

    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )

    assert accepted.status_code == 202
    body = accepted.json()
    assert body["run_id"] == run_id
    assert body["status"] == "RUNNING"
    assert body["inference_mode"] == "SIMULATED"
    assert "scripted" in body["model_identifier"]

    run = await wait_for_run(client, run_id, headers)

    assert run["status"] == "COMPLETED"
    assert run["inference_mode"] == "SIMULATED"
    assert run["error_category"] is None
    assert run["truthfulness"]["proposal_only"] is True
    assert run["truthfulness"]["live_inference"] is False
    assert run["truthfulness"]["inference_mode"] == "SIMULATED"
    assert run["truthfulness"]["approval_required"] is True

    # Exactly five allowlisted read calls, all successful.
    tools = run["tool_calls"]
    assert len(tools) == 5
    assert {item["tool_name"] for item in tools} == READ_TOOLS
    assert all(item["status"] == "OK" for item in tools)
    assert all(item["duration_ms"] >= 0 for item in tools)

    # Two provider turns: tool selection, then final JSON.
    assert len(run["provider_calls"]) == 2
    assert [call["step"] for call in run["provider_calls"]] == [1, 2]
    assert run["provider_calls"][0]["tool_calls"] == 5
    assert run["provider_calls"][1]["tool_calls"] == 0
    assert run["provider_calls"][1]["finish_reason"] == "stop"

    recommendation = run["recommendation"]
    assert recommendation is not None
    assert recommendation["status"] == "PENDING"
    assert recommendation["inference_mode"] == "SIMULATED"
    assert recommendation["facts"]
    assert recommendation["uncertainties"]
    assert recommendation["proposed_actions"]

    evidence_ids = set(recommendation["evidence_ids"])
    assert evidence_ids
    for fact in recommendation["facts"]:
        assert set(fact["evidence_ids"]) <= evidence_ids
    for action in recommendation["proposed_actions"]:
        assert set(action["evidence_ids"]) <= evidence_ids

    # Uncertainty invariant must survive the whole pipeline.
    assert any(
        item["question"] == "Was data exfiltrated?"
        for item in recommendation["uncertainties"]
    )


async def test_run_payload_contains_no_prompt_or_secret(app_factory, client_factory, stdb):
    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()

    run_id = "run_no_secret_001"
    stdb.set_run(run_id, status="REQUESTED")

    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    run = await wait_for_run(client, run_id, headers)
    text = json.dumps(run)

    assert "You are SentinelZero's incident analysis assistant" not in text
    assert "Authorization" not in text
    assert "test-only-secret" not in text
    assert "nvapi-" not in text
    assert "untrusted_incident_data" not in text


async def test_run_can_be_read_repeatedly_and_is_immutable_after_completion(
    app_factory, client_factory, stdb
):
    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()

    run_id = "run_immutable_001"
    stdb.set_run(run_id, status="REQUESTED")

    accepted = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    run_id = accepted.json()["run_id"]
    first = await wait_for_run(client, run_id, headers)
    second = (await client.get(f"/v1/agent-runs/{run_id}", headers=headers)).json()

    assert first["status"] == second["status"] == "COMPLETED"
    assert first["recommendation"]["id"] == second["recommendation"]["id"]
    assert first["finished_at"] == second["finished_at"]


async def test_unknown_run_returns_404(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/v1/agent-runs/run_does_not_exist", headers=auth_headers())

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_analyze_requires_run_id(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        ANALYZE, json={"incident_id": INCIDENT}, headers=auth_headers()
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
