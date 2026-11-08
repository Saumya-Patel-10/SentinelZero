"""Health, security headers, envelope, and request-boundary tests."""

from __future__ import annotations

import json

import pytest

from app.main import create_app
from conftest import ORG, auth_headers, test_settings


async def test_health_reports_truthful_scripted_posture(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "sentinelzero-ai"
    assert body["proposal_only"] is True
    assert body["secrets_exposed"] is False
    assert body["checks"] == {
        "provider_configured": True,
        "backend_ready": True,
    }
    assert body["provider"]["mode"] == "scripted"
    assert body["provider"]["inference_label"] == "SIMULATED_MODEL_OUTPUT"
    assert body["provider"]["live_inference_available"] is False
    assert body["backend"]["mode"] == "spacetimedb"
    assert body["backend"]["contract_status"] == "spacetimedb-1.1.0"
    assert body["inference_mode"] == "SIMULATED"
    assert body["inference_label"] == "SIMULATED_MODEL_OUTPUT"


async def test_health_never_exposes_secret_material(app_factory, client_factory):
    secret = "test-only-secret-" + ("x" * 32)
    api_key = "nvapi-" + ("a" * 40)
    settings = test_settings(
        provider_mode="live",
        nvidia_api_key=api_key,
        nvidia_base_url="https://integrate.api.nvidia.com/v1",
    )
    app = app_factory(settings=settings)
    client = await client_factory(app)

    response = await client.get("/health")

    assert response.status_code == 200
    text = response.text
    assert secret not in text
    assert api_key not in text
    assert "nvapi-" not in text
    assert response.json()["secrets_exposed"] is False


async def test_security_headers_and_generated_request_id(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/health")

    assert response.status_code == 200
    assert response.headers["x-request-id"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"


async def test_supplied_request_id_is_echoed_when_safe(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/health", headers={"x-request-id": "req-safe-123"})

    assert response.status_code == 200
    assert response.headers["x-request-id"] == "req-safe-123"


async def test_unsafe_request_id_is_replaced(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/health", headers={"x-request-id": "../../../etc/passwd"})

    assert response.status_code == 200
    rid = response.headers["x-request-id"]
    assert rid != "../../../etc/passwd"
    assert "/" not in rid


async def test_not_found_uses_safe_envelope(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/v1/agent-runs/run_does_not_exist", headers=auth_headers())

    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "NOT_FOUND"
    assert body["error"]["request_id"]


async def test_method_not_allowed_uses_safe_envelope(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.delete("/health", headers=auth_headers())

    assert response.status_code == 405
    body = response.json()
    assert body["error"]["code"] == "HTTP_ERROR"


async def test_request_validation_error_is_sanitized(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        f"/v1/incidents/{ORG}/analyze",
        json={"incident_id": ORG},  # missing run_id
        headers=auth_headers(),
    )

    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_FAILED"


async def test_oversized_body_is_rejected_before_authentication(client_factory):
    app = create_app()
    client = await client_factory(app)

    big = "x" * 200000
    response = await client.post(
        "/v1/incidents/inc_x/analyze",
        content=big,
        headers={"Content-Type": "text/plain", **auth_headers()},
    )

    assert response.status_code == 413
    body = response.json()
    assert body["error"]["code"] == "PAYLOAD_TOO_LARGE"


async def test_docs_are_disabled_in_production(app_factory, client_factory):
    settings = test_settings(environment="production", enable_docs=True)
    app = app_factory(settings=settings)
    client = await client_factory(app)

    for path in ("/docs", "/openapi.json"):
        response = await client.get(path)
        assert response.status_code == 404


async def test_org_marker_is_not_trusted_from_body(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        f"/v1/incidents/{ORG}/analyze",
        json={"incident_id": "org_other_001", "run_id": "run_x", "analysis_type": "intake"},
        headers=auth_headers(),
    )

    # The run_id is not registered in the fake stdb, so verify_agent_run_access
    # returns the default (run_id, INCIDENT, ORG). The URL incident_id is INCIDENT
    # but the body says org_other... actually the body incident_id is org_other_001
    # which doesn't match URL incident_id (ORG), so 403.
    assert response.status_code == 403
