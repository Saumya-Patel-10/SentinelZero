"""Submit a completed recommendation to the backend as PENDING human approval.

This endpoint deliberately cannot approve, reject, assign, or execute anything.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request, status

from app.auth import ANALYSIS_ROLES, Principal, get_principal, require_role
from app.errors import ACCESS_DENIED, INVALID_STATE, NOT_FOUND, VALIDATION_FAILED, ApiError
from app.schemas import SubmissionResult

router = APIRouter(tags=["recommendations"])

_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{3,100}$")
_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")


@router.post(
    "/v1/recommendations/{recommendation_id}/submit",
    response_model=SubmissionResult,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_recommendation(
    recommendation_id: str,
    request: Request,
    principal: Principal = Depends(get_principal),
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> SubmissionResult:
    require_role(principal, ANALYSIS_ROLES, action="submit recommendations")
    if not _ID_PATTERN.match(recommendation_id):
        raise ApiError(422, VALIDATION_FAILED, "Recommendation id is invalid.")
    if idempotency_key is not None and not _KEY_PATTERN.match(idempotency_key):
        raise ApiError(422, VALIDATION_FAILED, "Idempotency-Key is invalid.")

    store = request.app.state.store
    state = await store.find_by_recommendation(recommendation_id)
    if state is None or state.record.organization_id != principal.organization_id:
        raise ApiError(404, NOT_FOUND, "Recommendation was not found.")
    if state.record.status != "COMPLETED" or state.record.recommendation is None:
        raise ApiError(409, INVALID_STATE, "The recommendation is not ready for submission.")
    if (
        principal.subject != state.record.requested_by
        and not any(role in {"OWNER", "COMMANDER", "ANALYST"} for role in principal.roles)
    ):
        raise ApiError(403, ACCESS_DENIED, "You may not submit this recommendation.")

    decision = await request.app.state.backend.authorize_incident(
        principal, state.record.incident_id, "ai.submit_recommendation"
    )
    if not decision.allowed:
        raise ApiError(403, ACCESS_DENIED, "Incident access is no longer authorized.")

    existing = await store.get_submission(state.record.run_id, recommendation_id)
    if existing is not None:
        return existing.model_copy(
            update={"duplicate": True, "submitted": True}
        )

    key = idempotency_key or f"{state.record.run_id}:{recommendation_id}"
    reference = await request.app.state.backend.submit_recommendation(
        recommendation=state.record.recommendation,
        requested_by=principal.subject,
        idempotency_key=key,
    )
    result = SubmissionResult(
        recommendation_id=recommendation_id,
        run_id=state.record.run_id,
        backend_reference=reference,
        approval_status="PENDING_HUMAN_APPROVAL",
        submitted=True,
        duplicate=False,
        message=(
            "Submitted as a PENDING proposal. A human commander must approve it in the "
            "operational backend; the AI service cannot approve or execute it."
        ),
    )
    await store.record_submission(state.record.run_id, result)
    return result
