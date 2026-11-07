"""End-to-end scripted workflow: evidence, tool calls, bounded agent, proposals."""

from __future__ import annotations

import json

from conftest import INCIDENT, auth_headers, wait_for_run

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"
READ_TOOLS = {
    "get_incident",
    "get_assets",
    "get_dependencies",
    "get_open_tasks",
    "get_evidence_summaries",
}


async def test_scripted_run_completes_with_tool_round_trip(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()

    accepted = await client.post(ANALYZE, json={"focus": "Confirm exfiltration is unknown"}, headers=headers)

    assert accepted.status_code == 202
    body = accepted.json()
    assert body["status"] == "QUEUED"
    assert body["incident_id"] == INCIDENT
    assert body["provider_mode"] == "scripted"
    assert body["inference_label"] == "SIMULATED_MODEL_OUTPUT"
    assert body["live_inference"] is False
    assert body["exercise_label"] == "EXERCISE"
    assert "SIMULATED" in body["notice"]
    assert "human approval" in body["notice"]

    run = await wait_for_run(client, body["run_id"], headers)

    assert run["status"] == "COMPLETED"
    assert run["provider_mode"] == "scripted"
    assert run["inference_label"] == "SIMULATED_MODEL_OUTPUT"
    assert run["error_category"] is None
    assert run["truthfulness"] == {
        "proposal_only": True,
        "live_inference": False,
        "inference_label": "SIMULATED_MODEL_OUTPUT",
        "exercise_label": "EXERCISE",
        "approval_required": True,
        "notice": "SIMULATED or non-attested model output; not live NVIDIA inference.",
    }

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
    assert recommendation["approval_status"] == "PENDING_HUMAN_APPROVAL"
    assert recommendation["submitted"] is False
    assert recommendation["provider_mode"] == "scripted"
    assert recommendation["inference_label"] == "SIMULATED_MODEL_OUTPUT"
    assert recommendation["exercise_label"] == "EXERCISE"
    assert "SIMULATED ANALYST OUTPUT" in recommendation["summary"]
    assert recommendation["facts"]
    assert recommendation["uncertainties"]
    assert recommendation["proposed_tasks"]

    evidence_ids = set(recommendation["evidence_ids_used"])
    assert evidence_ids
    assert evidence_ids <= {
        "ev_ad_auth",
        "ev_backup_log",
        "ev_dns_log",
        "ev_edr_alert",
        "ev_mail_gateway",
        "ev_net_flow",
        "ev_ransom_note",
        "ev_file_lock",
        "ev_ehr_db_access",
        "ev_sched_outage",
        "ev_billing_scan",
        "ev_pacs_outage",
    }
    for fact in recommendation["facts"]:
        assert set(fact["evidence_ids"]) <= evidence_ids
    for task in recommendation["proposed_tasks"]:
        assert task["requires_human_approval"] is True
        assert task["evidence_basis"] in {
            "EVIDENCE_BACKED",
            "CONTINUITY_PRACTICE",
            "UNVERIFIED_INFERENCE",
        }
        assert set(task["evidence_ids"]) <= evidence_ids

    # Uncertainty invariant must survive the whole pipeline.
    assert any(
        item["question"] == "Was data exfiltrated before encryption or outage?"
        for item in recommendation["uncertainties"]
    )


async def test_run_payload_contains_no_prompt_or_secret(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()

    accepted = await client.post(ANALYZE, json={}, headers=headers)
    run = await wait_for_run(client, accepted.json()["run_id"], headers)
    text = json.dumps(run)

    assert "You are SentinelZero's incident analysis assistant" not in text
    assert "Authorization" not in text
    assert "test-only-secret" not in text
    assert "nvapi-" not in text
    assert "untrusted_incident_data" not in text


async def test_run_can_be_read_repeatedly_and_is_immutable_after_completion(
    app_factory, client_factory
):
    app = app_factory()
    client = await client_factory(app)
    headers = auth_headers()

    accepted = await client.post(ANALYZE, json={}, headers=headers)
    run_id = accepted.json()["run_id"]
    first = await wait_for_run(client, run_id, headers)
    second = (await client.get(f"/v1/agent-runs/{run_id}", headers=headers)).json()

    assert first["status"] == second["status"] == "COMPLETED"
    assert first["recommendation"]["recommendation_id"] == second["recommendation"]["recommendation_id"]
    assert first["finished_at"] == second["finished_at"]


async def test_unknown_run_returns_404(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/v1/agent-runs/run_does_not_exist", headers=auth_headers())

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
