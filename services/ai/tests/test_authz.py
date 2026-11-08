"""Authorization tests: verify_agent_run_access is the sole authorization path.

The AI service never authorizes from JWT org_id/roles claims. It forwards the
caller's bearer token to SpacetimeDB's verify_agent_run_access procedure.
"""

from __future__ import annotations

from conftest import INCIDENT, ORG, auth_headers, wait_for_run

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"


async def test_analyze_requires_bearer_token(app_factory, client_factory, stdb):
    app = app_factory()
    client = await client_factory(app)
    stdb.set_run("run_no_token_001", status="REQUESTED")

    response = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": "run_no_token_001", "analysis_type": "intake"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"


async def test_verify_agent_run_access_denied(app_factory, client_factory, stdb):
    """When the fake stdb returns authorized=false, the service denies access."""

    def deny_access(args):
        return [False, False, "", args[0] if args else "", "", "", ""]

    stdb.handlers["verify_agent_run_access"] = deny_access

    app = app_factory()
    client = await client_factory(app)
    stdb.set_run("run_denied_001", status="REQUESTED")

    response = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": "run_denied_001", "analysis_type": "intake"},
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_non_requester_cannot_analyze(app_factory, client_factory, stdb):
    """isRequester=false means the caller cannot start analysis."""

    def non_requester(args):
        return [True, False, "ANALYST", args[0] if args else "", INCIDENT, ORG, "REQUESTED"]

    stdb.handlers["verify_agent_run_access"] = non_requester

    app = app_factory()
    client = await client_factory(app)
    stdb.set_run("run_non_requester_001", status="REQUESTED")

    response = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": "run_non_requester_001", "analysis_type": "intake"},
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_run_not_requested_cannot_analyze(app_factory, client_factory, stdb):
    """A run that is not REQUESTED cannot be analyzed."""

    app = app_factory()
    client = await client_factory(app)
    stdb.set_run("run_not_requested_001", status="RUNNING")

    response = await client.post(
        ANALYZE,
        json={"incident_id": INCIDENT, "run_id": "run_not_requested_001", "analysis_type": "intake"},
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_incident_id_mismatch_is_denied(app_factory, client_factory, stdb):
    """The URL incident_id must match the run's incident."""

    app = app_factory()
    client = await client_factory(app)
    stdb.set_run("run_mismatch_001", status="REQUESTED", incident_id="inc_other_001")

    response = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze",
        json={"incident_id": INCIDENT, "run_id": "run_mismatch_001", "analysis_type": "intake"},
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"
