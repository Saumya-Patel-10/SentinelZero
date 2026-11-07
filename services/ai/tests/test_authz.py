"""Authentication and incident-authorization tests.

Identity and tenant come only from the verified token; incident membership is
checked independently by the backend on every operation.
"""

from __future__ import annotations

import jwt
import pytest

from conftest import (
    ANALYST,
    COMMANDER,
    INCIDENT,
    ORG,
    RESPONDER,
    TEST_SECRET,
    auth_headers,
    test_settings,
)

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"


def _token(claims: dict, secret: str = TEST_SECRET) -> str:
    return jwt.encode(claims, secret, algorithm="HS256")


async def test_analyze_requires_bearer_token(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(ANALYZE, json={})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"
    assert response.headers["www-authenticate"] == "Bearer"


async def test_invalid_signature_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers(secret="wrong-secret-" + ("z" * 40))
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"


async def test_wrong_audience_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers(audience="some-other-service")
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 401


async def test_wrong_issuer_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers(issuer="attacker-issuer")
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 401


async def test_expired_token_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers(subject=ANALYST, ttl_seconds=-60)
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"


async def test_token_without_organization_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)
    claims = {
        "sub": ANALYST,
        "roles": ["ANALYST"],
        "iss": "sentinelzero-auth",
        "aud": "sentinelzero-ai",
        "iat": 1_700_000_000,
        "exp": 4_100_000_000,
    }
    headers = {"Authorization": f"Bearer {_token(claims)}"}

    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"


async def test_unknown_role_is_rejected(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers(subject=ANALYST, roles=["SUPERUSER"])
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


@pytest.mark.parametrize("role", ["RESPONDER", "OBSERVER"])
async def test_non_analysis_roles_cannot_start_analysis(role, app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    subject = RESPONDER if role == "RESPONDER" else "observer@riverbend.exercise.invalid"
    response = await client.post(ANALYZE, json={}, headers=auth_headers(subject=subject, roles=[role]))

    assert response.status_code == 403
    assert "not permitted" in response.json()["error"]["message"]


async def test_token_role_must_match_incident_membership(app_factory, client_factory):
    """A forged higher role does not grant incident access if membership differs."""

    app = app_factory()
    client = await client_factory(app)

    # Subject is a RESPONDER member, but the token claims ANALYST. The backend
    # membership check must use the stored role, not the token role.
    headers = auth_headers(subject=RESPONDER, roles=["ANALYST"])
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_cross_organization_access_is_denied(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers(subject=ANALYST, roles=["ANALYST"], organization_id="org_other_999")
    response = await client.post(ANALYZE, json={}, headers=headers)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_unknown_incident_is_not_enumerated(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    headers = auth_headers()
    response = await client.post("/v1/incidents/inc_does_not_exist/analyze", json={}, headers=headers)

    # 403 (not 404) avoids confirming existence to unauthorized callers.
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_revoked_membership_is_denied(app_factory, client_factory, state):
    for membership in state["memberships"]:
        if membership["user_identity"] == ANALYST:
            membership["revoked_at"] = "2026-03-14T02:00:00Z"
    app = app_factory(backend_state=state)
    client = await client_factory(app)

    response = await client.post(ANALYZE, json={}, headers=auth_headers())

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ACCESS_DENIED"


async def test_lowercase_role_claim_is_normalized(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(ANALYZE, json={}, headers=auth_headers(roles=["analyst"]))

    assert response.status_code == 202


async def test_run_read_requires_same_organization(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)
    analyst = auth_headers()
    accepted = await client.post(ANALYZE, json={}, headers=analyst)
    run_id = accepted.json()["run_id"]

    other_org = auth_headers(subject="analyst@other.invalid", organization_id="org_other_999")
    response = await client.get(f"/v1/agent-runs/{run_id}", headers=other_org)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_commander_can_read_any_run_in_org(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)
    analyst = auth_headers()
    accepted = await client.post(ANALYZE, json={}, headers=analyst)
    run_id = accepted.json()["run_id"]

    commander = auth_headers(subject=COMMANDER, roles=["COMMANDER"])
    response = await client.get(f"/v1/agent-runs/{run_id}", headers=commander)

    assert response.status_code == 200


async def test_auth_fails_closed_when_not_configured(client_factory):
    from app.main import create_app

    settings = test_settings(jwt_secret=None)
    app = create_app(settings=settings)
    client = await client_factory(app)

    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["checks"]["auth_configured"] is False
    assert response.json()["status"] == "degraded"

    analyze = await client.post(ANALYZE, json={}, headers={"Authorization": "Bearer any"})
    assert analyze.status_code == 503
    assert analyze.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
