"""Recommendation endpoints.

Recommendations are submitted internally by the agent loop through
``agent_submit_recommendation`` (SpacetimeDB service-principal call).  The
browser reads recommendations from the ``my_recommendations`` view and human
approval/rejection happens through the ``approve_recommendation`` /
``reject_recommendation`` reducers in SpacetimeDB -- not through this service.

This router is retained for compatibility; submission is no longer a client
action.  Any direct submit attempt returns 404 because there is no
approve/execute capability in the AI service.
"""

from __future__ import annotations

from fastapi import APIRouter, status

from app.errors import NOT_FOUND, ApiError

router = APIRouter(tags=["recommendations"])


@router.post(
    "/v1/recommendations/{recommendation_id}/submit",
    status_code=status.HTTP_404_NOT_FOUND,
)
async def submit_recommendation(recommendation_id: str) -> None:
    """Recommendation submission is internal to the agent loop.

    The AI service submits PENDING recommendations through
    ``agent_submit_recommendation``.  Human approval happens in the operational
    backend via ``approve_recommendation``.  This endpoint does not exist.
    """
    raise ApiError(404, NOT_FOUND, "Recommendation submission is handled by the backend; there is no submit endpoint in the AI service.")
