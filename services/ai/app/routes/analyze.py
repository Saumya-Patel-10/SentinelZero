"""Analysis creation, run status, and cancellation endpoints.

The browser first calls SpacetimeDB's ``request_agent_run`` reducer (with its own
user token) to create a REQUESTED run, then calls this service with the run id.
The AI service verifies access through ``verify_agent_run_access`` using the
forwarded bearer token, claims the run, and executes the bounded agent loop.

No run IDs are minted here; the run_id must be the SpacetimeDB run id.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, status

from app.auth import (
    RunAccess,
    caller_key,
    extract_bearer_token,
    require_authorized,
    require_can_analyze,
    require_can_cancel,
    require_can_read_run,
    verify_run_access,
)
from app.config import Settings
from app.errors import (
    AI_PROVIDER_NOT_CONFIGURED,
    ACCESS_DENIED,
    INVALID_STATE,
    NOT_FOUND,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    VALIDATION_FAILED,
    ApiError,
)
from app.runtime import acceptance_notice
from app.schemas import AnalysisAccepted, AnalysisRequest, RunRecord, initial_subagents
from app.store import RunState

logger = logging.getLogger("sentinelzero.ai.routes.analyze")

router = APIRouter(tags=["analysis"])

_ROLES = {"OWNER", "COMMANDER", "ANALYST", "RESPONDER", "OBSERVER"}


def _limit_key(organization_id: str, principal: str) -> str:
    return f"{organization_id}:{principal}"


async def _load_run(request: Request, run_id: str) -> RunState:
    state = await request.app.state.store.get_state(run_id)
    if state is None:
        raise ApiError(404, NOT_FOUND, "Agent run was not found.")
    return state


@router.post(
    "/v1/incidents/{incident_id}/analyze",
    response_model=AnalysisAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze_incident(
    incident_id: str,
    request: Request,
    body: AnalysisRequest | None = None,
) -> AnalysisAccepted:
    settings: Settings = request.app.state.settings
    backend = request.app.state.backend
    provider = request.app.state.provider

    # The run_id comes from the browser's request_agent_run call (request body).
    run_id = body.run_id if body else None
    if not run_id:
        raise ApiError(422, VALIDATION_FAILED, "run_id is required.")
    if body and body.incident_id != incident_id:
        raise ApiError(403, ACCESS_DENIED, "Run incident does not match the requested incident.")

    # Extract the bearer token and verify access via SpacetimeDB.
    token = extract_bearer_token(request)
    if not await backend.ready():
        raise ApiError(
            503,
            SERVICE_UNAVAILABLE,
            "Backend authorization is not configured.",
            details={"category": "BACKEND_NOT_CONFIGURED"},
        )
    result = await backend.verify_agent_run_access(token, run_id)

    access = RunAccess(
        authorized=result.authorized,
        is_requester=result.is_requester,
        role=result.role,
        run_id=result.run_id,
        incident_id=result.incident_id,
        organization_id=result.organization_id,
        status=result.status,
    )
    require_authorized(access, action="start analysis")

    if access.incident_id != incident_id:
        raise ApiError(403, ACCESS_DENIED, "Run does not belong to the requested incident.")
    require_can_analyze(access)

    if not provider.descriptor.configured:
        raise ApiError(
            503,
            SERVICE_UNAVAILABLE,
            "The AI provider is not configured. Manual incident workflows remain available.",
            details={"category": AI_PROVIDER_NOT_CONFIGURED},
        )

    # Rate limit and concurrency are per verified caller, not per run: a fresh
    # run id must never yield a fresh bucket.
    principal = caller_key(token)
    limit_key = _limit_key(access.organization_id, principal)
    allowed, retry_after = await request.app.state.runtime.rate_limiter.check(limit_key)
    if not allowed:
        raise ApiError(
            429,
            RATE_LIMITED,
            "Too many analysis requests. Retry later.",
            headers={"Retry-After": str(retry_after)},
            details={"retry_after_seconds": retry_after},
        )

    # Per-user concurrency.
    concurrency_key = limit_key
    if not await request.app.state.runtime.concurrency.acquire(concurrency_key):
        raise ApiError(
            429,
            RATE_LIMITED,
            "Too many concurrent analyses for this user.",
            headers={"Retry-After": "5"},
        )

    record = RunRecord(
        run_id=run_id,
        organization_id=access.organization_id,
        incident_id=access.incident_id,
        requested_by=principal,  # pseudonymous key; the identity lives in SpacetimeDB
        requested_role=access.role if access.role in _ROLES else "ANALYST",
        status="REQUESTED",
        inference_mode=settings.inference_mode,
        model_identifier=provider.descriptor.model_identifier[:120],
        analysis_type=body.analysis_type if body else "intake",
        focus=None,
        created_at=datetime.now(timezone.utc),
        agent_mode=settings.agent_mode,
        subagents=initial_subagents("PENDING" if settings.agent_mode == "orchestrated" else "SKIPPED"),
    )

    store = request.app.state.store
    if not await store.create_if_absent(record):
        # A concurrent or repeated start for the same run must not spawn a
        # second agent loop (claims are idempotent for the same principal).
        await request.app.state.runtime.concurrency.release(concurrency_key)
        raise ApiError(409, INVALID_STATE, "Analysis for this run has already started.")
    try:
        await request.app.state.runtime.start(record, access, concurrency_key)
    except Exception:
        await store.discard(run_id)
        await request.app.state.runtime.concurrency.release(concurrency_key)
        raise

    return request.app.state.runtime.analysis_accepted(record)


@router.get("/v1/agent-runs/{run_id}")
async def get_agent_run(
    run_id: str,
    request: Request,
    access: RunAccess = Depends(verify_run_access),
) -> dict:
    # Authorize before revealing whether the run exists locally.
    require_can_read_run(access)
    state = await _load_run(request, run_id)

    record = state.record
    if (
        record.organization_id != access.organization_id
        or record.incident_id != access.incident_id
        or access.run_id != run_id
    ):
        raise ApiError(404, NOT_FOUND, "Agent run was not found.")

    payload = record.model_dump(mode="json")
    order = {name: index for index, name in enumerate(SUBAGENT_ORDER)}
    payload["subagents"] = sorted(payload["subagents"], key=lambda item: order[item["name"]])
    payload["sitrep"] = payload.get("sitrep") or ""
    payload["truthfulness"] = {
        "proposal_only": True,
        "live_inference": record.inference_mode == "LIVE",
        "inference_mode": record.inference_mode,
        "inference_label": request.app.state.settings.inference_label,
        "approval_required": True,
        "notice": acceptance_notice(record.inference_mode),
    }
    return payload


@router.post("/v1/agent-runs/{run_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
async def cancel_agent_run(
    run_id: str,
    request: Request,
    access: RunAccess = Depends(verify_run_access),
) -> dict:
    state = await _load_run(request, run_id)
    if state.record.status in {"COMPLETED", "FAILED", "CANCELLED", "EXPIRED"}:
        raise ApiError(409, INVALID_STATE, "The run is already finished and cannot be cancelled.")
    require_can_cancel(access)
    await request.app.state.runtime.cancel(run_id)
    return {"run_id": run_id, "status": "CANCELLED"}
