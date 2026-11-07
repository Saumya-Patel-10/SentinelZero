"""Health and readiness information without secrets."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict:
    settings = request.app.state.settings
    backend = request.app.state.backend
    provider = request.app.state.provider
    backend_ready = await backend.ready()
    auth_configured = settings.auth_configured
    provider_configured = provider.descriptor.configured
    live_inference_available = provider_configured and settings.inference_label == "LIVE_NVIDIA_INFERENCE"

    status = "ok" if (auth_configured and provider_configured and backend_ready) else "degraded"
    return {
        "status": status,
        "service": "sentinelzero-ai",
        "version": settings.service_version,
        "time": datetime.now(timezone.utc).isoformat(),
        "checks": {
            "auth_configured": auth_configured,
            "provider_configured": provider_configured,
            "backend_ready": backend_ready,
        },
        "provider": {
            "mode": provider.descriptor.mode,
            "endpoint_class": provider.descriptor.endpoint_class,
            "model_identifier": provider.descriptor.model_identifier,
            "inference_label": provider.descriptor.inference_label,
            "live_inference_available": live_inference_available,
        },
        "backend": {
            "mode": backend.mode,
            "contract_version": backend.contract_version,
            "contract_status": "MOCK_AWAITING_AGENT1" if backend.mode == "memory" else "MOCK_UNVERIFIED",
        },
        "simulation": {
            "exercise_backend": backend.mode == "memory",
            "provider_mode": provider.descriptor.mode,
            "label": provider.descriptor.inference_label,
            "notice": (
                "Synthetic EXERCISE data and/or simulated model output. "
                "Not live NVIDIA inference."
                if provider.descriptor.mode == "scripted" or backend.mode == "memory"
                else "Live provider mode."
            ),
        },
        "proposal_only": True,
        "secrets_exposed": False,
    }
