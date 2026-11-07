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
        "auth_configured": True,
        "provider_configured": True,
        "backend_ready": True,
    }
    assert body["provider"]["mode"] == "scripted"
    assert body["provider"]["inference_label"] == "SIMULATED_MODEL_OUTPUT"
    assert body["provider"]["live_inference_available"] is False
    assert body["backend"]["mode"] == "memory"
    assert body["backend"]["contract_status"] == "MOCK_AWAITING_AGENT1"
    assert body["simulation"]["exercise_backend"] is True
    assert "Not live NVIDIA inference" in body["simulation"]["notice"]


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

    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cache-control"] == "no-store"
    request_id = response.headers["x-request-id"]
    assert len(request_id) >= 8


async def test_supplied_request_id_is_echoed_when_safe(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/health", headers={"X-Request-ID": "demo-request-0001"})

    assert response.headers["x-request-id"] == "demo-request-0001"


async def test_unsafe_request_id_is_replaced(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/health", headers={"X-Request-ID": "bad id with spaces"})

    assert response.headers["x-request-id"] != "bad id with spaces"
    assert len(response.headers["x-request-id"]) == 32


async def test_not_found_uses_safe_envelope(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.get("/v1/does-not-exist")

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "NOT_FOUND"
    assert error["message"] == "Resource was not found."
    assert error["request_id"] == response.headers["x-request-id"]


async def test_method_not_allowed_uses_safe_envelope(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.put("/health")

    assert response.status_code == 405
    assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


async def test_request_validation_error_is_sanitized(app_factory, client_factory):
    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        "/v1/incidents/inc_riverbend_ransomware_001/analyze",
        json={"focus": "<script>alert(1)</script>"},
        headers=auth_headers(),
    )

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["message"] == "Request validation failed."
    # Location/type only; never the submitted value.
    assert "<script>" not in response.text
    assert all(set(item) == {"loc", "type"} for item in error["details"]["errors"])


async def test_oversized_body_is_rejected_before_authentication(client_factory):
    settings = test_settings(max_body_bytes=1024)
    app = create_app(settings=settings)
    client = await client_factory(app)

    response = await client.post(
        "/v1/incidents/inc_riverbend_ransomware_001/analyze",
        content=json.dumps({"focus": "x" * 2048}),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("path", ["/openapi.json", "/docs"])
async def test_docs_are_disabled_in_production(path, client_factory):
    settings = test_settings(
        environment="production",
        provider_mode="live",
        jwt_secret="production-secret-" + ("y" * 32),
    )
    app = create_app(settings=settings)
    client = await client_factory(app)

    response = await client.get(path)

    assert response.status_code == 404


async def test_org_marker_is_not_trusted_from_body(app_factory, client_factory):
    """A caller cannot override organization with a request field."""

    app = app_factory()
    client = await client_factory(app)

    response = await client.post(
        "/v1/incidents/inc_riverbend_ransomware_001/analyze",
        json={"focus": "review", "organization_id": ORG},
        headers=auth_headers(),
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
