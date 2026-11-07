"""Recommendation submission: pending-only, idempotent, authorized."""

from __future__ import annotations

import pytest

from conftest import (
    ANALYST,
    COMMANDER,
    INCIDENT,
    RESPONDER,
    auth_headers,
    make_recording_app,
    wait_for_run,
)

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"


async def _completed(client, headers) -> dict:
    accepted = await client.post(ANALYZE, json={}, headers=headers)
    assert accepted.status_code == 202
    return await wait_for_run(client, accepted.json()["run_id"], headers)


async def test_submit_creates_pending_proposal(app_factory, client_factory, state):
    app, backend = make_recording_app(app_factory, state)
    client = await client_factory(app)
    headers = auth_headers()
    run = await _completed(client, headers)
    recommendation_id = run["recommendation"]["recommendation_id"]

    response = await client.post(
        f"/v1/recommendations/{recommendation_id}/submit",
        headers={**headers, "Idempotency-Key": "demo-submit-001"},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["approval_status"] == "PENDING_HUMAN_APPROVAL"
    assert body["submitted"] is True
    assert body["duplicate"] is False
    assert body["backend_reference"].startswith("mock-submission-")
    assert "human commander must approve" in body["message"]

    assert len(backend.submissions) == 1
    submitted = backend.submissions[0]
    assert submitted["requested_by"] == ANALYST
    assert submitted["idempotency_key"] == "demo-submit-001"
    assert submitted["recommendation"]["approval_status"] == "PENDING_HUMAN_APPROVAL"
    assert all(
        task["requires_human_approval"] is True
        for task in submitted["recommendation"]["proposed_tasks"]
    )

    # The run record reflects submission without changing the approval state.
    stored = (await client.get(f"/v1/agent-runs/{run['run_id']}", headers=headers)).json()
    assert stored["recommendation"]["submitted"] is True
    assert stored["recommendation"]["submitted_reference"] == body["backend_reference"]
    assert stored["recommendation"]["approval_status"] == "PENDING_HUMAN_APPROVAL"


async def test_duplicate_submit_is_idempotent(app_factory, client_factory, state):
    app, backend = make_recording_app(app_factory, state)
    client = await client_factory(app)
    headers = auth_headers()
    run = await _completed(client, headers)
    recommendation_id = run["recommendation"]["recommendation_id"]
    url = f"/v1/recommendations/{recommendation_id}/submit"

    first = await client.post(url, headers={**headers, "Idempotency-Key": "key-one"})
    second = await client.post(url, headers={**headers, "Idempotency-Key": "key-two"})

    assert first.status_code == second.status_code == 202
    assert second.json()["duplicate"] is True
    assert second.json()["backend_reference"] == first.json()["backend_reference"]
    assert len(backend.submissions) == 1


async def test_commander_can_submit(app_factory, client_factory, state):
    app, _ = make_recording_app(app_factory, state)
    client = await client_factory(app)
    analyst = auth_headers()
    run = await _completed(client, analyst)
    recommendation_id = run["recommendation"]["recommendation_id"]

    commander = auth_headers(subject=COMMANDER, roles=["COMMANDER"])
    response = await client.post(
        f"/v1/recommendations/{recommendation_id}/submit", headers=commander
    )

    assert response.status_code == 202


@pytest.mark.parametrize("role", ["RESPONDER", "OBSERVER"])
async def test_non_analysis_roles_cannot_submit(role, app_factory, client_factory, state):
    app, _ = make_recording_app(app_factory, state)
    client = await client_factory(app)
    analyst = auth_headers()
    run = await _completed(client, analyst)
    recommendation_id = run["recommendation"]["recommendation_id"]

    subject = RESPONDER if role == "RESPONDER" else "observer@riverbend.exercise.invalid"
    response = await client.post(
        f"/v1/recommendations/{recommendation_id}/submit",
        headers=auth_headers(subject=subject, roles=[role]),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_cross_organization_submit_is_not_found(app_factory, client_factory, state):
    app, _ = make_recording_app(app_factory, state)
    client = await client_factory(app)
    run = await _completed(client, auth_headers())
    recommendation_id = run["recommendation"]["recommendation_id"]

    other = auth_headers(subject="analyst@other.invalid", organization_id="org_other_999")
    response = await client.post(
        f"/v1/recommendations/{recommendation_id}/submit", headers=other
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_unknown_recommendation_is_not_found(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        "/v1/recommendations/rec_does_not_exist/submit", headers=auth_headers()
    )

    assert response.status_code == 404


async def test_invalid_recommendation_id_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        "/v1/recommendations/!!!/submit", headers=auth_headers()
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


async def test_invalid_idempotency_key_is_rejected(app_factory, client_factory, state):
    app, _ = make_recording_app(app_factory, state)
    client = await client_factory(app)
    headers = auth_headers()
    run = await _completed(client, headers)

    response = await client.post(
        f"/v1/recommendations/{run['recommendation']['recommendation_id']}/submit",
        headers={**headers, "Idempotency-Key": "bad key with spaces"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


async def test_incomplete_run_cannot_be_submitted(app_factory, client_factory, state):
    app, _ = make_recording_app(app_factory, state)
    client = await client_factory(app)
    headers = auth_headers()
    run = await _completed(client, headers)
    recommendation_id = run["recommendation"]["recommendation_id"]

    store_state = await app.state.store.get_state(run["run_id"])
    store_state.record.status = "RUNNING"

    response = await client.post(
        f"/v1/recommendations/{recommendation_id}/submit", headers=headers
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "INVALID_STATE"
