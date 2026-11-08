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
    provider_configured = provider.descriptor.configured

    status = "ok" if (provider_configured and backend_ready) else "degraded"
    return {
        "status": status,
        "service": "sentinelzero-ai",
        "version": settings.service_version,
        "time": datetime.now(timezone.utc).isoformat(),
        "checks": {
            "provider_configured": provider_configured,
            "backend_ready": backend_ready,
        },
        "provider": {
            "mode": provider.descriptor.mode,
            "endpoint_class": provider.descriptor.endpoint_class,
            "model_identifier": provider.descriptor.model_identifier,
            "inference_label": provider.descriptor.inference_label,
            "live_inference_available": provider_configured
            and settings.inference_label == "LIVE_NVIDIA_INFERENCE",
        },
        "backend": {
            "mode": backend.mode,
            "contract_version": backend.contract_version,
            "contract_status": "spacetimedb-1.1.0",
        },
        "inference_mode": settings.inference_mode,
        "inference_label": settings.inference_label,
        "proposal_only": True,
        "secrets_exposed": False,
    }
