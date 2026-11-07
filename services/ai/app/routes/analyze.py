"""Analysis creation, run status, and cancellation endpoints."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from fastapi.params import Path

from app.auth import ANALYSIS_ROLES, Principal, get_principal, require_role
from app.errors import (
    ACCESS_DENIED,
    AI_PROVIDER_NOT_CONFIGURED,
    INVALID_STATE,
    NOT_FOUND,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    ApiError,
)
from app.runtime import analysis_accepted
from app.schemas import AnalysisAccepted, AnalysisRequest, RunRecord
from app.store import RunState

router = APIRouter(tags=["analysis"])

IncidentId = Annotated[str, Path(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.:-]+$")]
RunId = Annotated[str, Path(min_length=3, max_length=100, pattern=r"^[A-Za-z0-9_.:-]+$")]


def _key(principal: Principal) -> str:
    return f"{principal.organization_id}:{principal.subject}"


def _run_payload(record: RunRecord) -> dict:
    payload = record.model_dump(mode="json")
    payload["truthfulness"] = {
        "proposal_only": True,
        "live_inference": record.inference_label == "LIVE_NVIDIA_INFERENCE",
        "inference_label": record.inference_label,
        "exercise_label": record.exercise_label,
        "approval_required": True,
        "notice": (
            "LIVE NVIDIA inference; every proposed task still requires human approval."
            if record.inference_label == "LIVE_NVIDIA_INFERENCE"
            else "SIMULATED or non-attested model output; not live NVIDIA inference."
        ),
    }
    return payload


async def _load_run(request: Request, principal: Principal, run_id: str) -> RunState:
    state = await request.app.state.store.get_state(run_id)
    if state is None or state.record.organization_id != principal.organization_id:
        raise ApiError(404, NOT_FOUND, "Agent run was not found.")
    return state


async def _authorize_run(
    request: Request, principal: Principal, state: RunState, action: str
) -> None:
    decision = await request.app.state.backend.authorize_incident(
        principal, state.record.incident_id, action
    )
    if not decision.allowed:
        raise ApiError(403, ACCESS_DENIED, "Incident access is no longer authorized.")


@router.post(
    "/v1/incidents/{incident_id}/analyze",
    response_model=AnalysisAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze_incident(
    incident_id: IncidentId,
    request: Request,
    body: AnalysisRequest | None = None,
    principal: Principal = Depends(get_principal),
) -> AnalysisAccepted:
    require_role(principal, ANALYSIS_ROLES, action="request AI analysis")
    runtime = request.app.state.runtime
    provider = request.app.state.provider

    allowed, retry_after = await runtime.rate_limiter.check(_key(principal))
    if not allowed:
        raise ApiError(
            429,
            RATE_LIMITED,
            "Too many analysis requests. Retry later.",
            headers={"Retry-After": str(retry_after)},
            details={"retry_after_seconds": retry_after},
        )

    decision = await request.app.state.backend.authorize_incident(
        principal, incident_id, "ai.analyze"
    )
    if not decision.allowed or decision.incident is None:
        raise ApiError(403, ACCESS_DENIED, "Incident analysis is not authorized.")

    if not provider.descriptor.configured:
        raise ApiError(
            503,
            SERVICE_UNAVAILABLE,
            "The AI provider is not configured. Manual incident workflows remain available.",
            details={"category": AI_PROVIDER_NOT_CONFIGURED},
        )

    concurrency_key = _key(principal)
    if not await runtime.concurrency.acquire(concurrency_key):
        raise ApiError(
            429,
            RATE_LIMITED,
            "Too many concurrent analyses for this user.",
            headers={"Retry-After": "5"},
        )

    focus = body.focus if body else None
    run_id = f"run_{secrets.token_hex(12)}"
    record = RunRecord(
        run_id=run_id,
        organization_id=principal.organization_id,
        incident_id=incident_id,
        requested_by=principal.subject,
        requested_role=decision.role or principal.roles[0],
        status="QUEUED",
        provider_mode=provider.descriptor.mode,
        endpoint_class=provider.descriptor.endpoint_class,
        inference_label=provider.descriptor.inference_label,
        model_identifier=provider.descriptor.model_identifier,
        exercise_label=decision.incident.exercise_label or "EXERCISE",
        focus=focus,
        created_at=datetime.now(timezone.utc),
    )
    try:
        await request.app.state.store.create(record)
        await runtime.start(record, principal, concurrency_key)
    except Exception:
        await runtime.concurrency.release(concurrency_key)
        raise
    return analysis_accepted(record, provider)


@router.get("/v1/agent-runs/{run_id}")
async def get_agent_run(
    run_id: RunId,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict:
    state = await _load_run(request, principal, run_id)
    await _authorize_run(request, principal, state, "ai.read_run")
    return _run_payload(state.record)


@router.post("/v1/agent-runs/{run_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
async def cancel_agent_run(
    run_id: RunId,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> dict:
    state = await _load_run(request, principal, run_id)
    if state.record.status in {"COMPLETED", "FAILED", "CANCELLED"}:
        raise ApiError(409, INVALID_STATE, "The run is already finished and cannot be cancelled.")
    if (
        principal.subject != state.record.requested_by
        and not any(role in {"OWNER", "COMMANDER"} for role in principal.roles)
    ):
        raise ApiError(403, ACCESS_DENIED, "Only the requester or a commander may cancel.")
    await _authorize_run(request, principal, state, "ai.cancel_run")
    await request.app.state.runtime.cancel(run_id)
    return {"run_id": run_id, "status": "CANCELLED"}
