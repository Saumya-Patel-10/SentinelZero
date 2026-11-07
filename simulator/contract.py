"""Typed MOCK contract required from Agent 1 for real SpacetimeDB integration.

This module intentionally contains declarations only. It does not connect to a
real backend. Replace the MOCK adapter only after Agent 1 freezes its contract.
"""

from __future__ import annotations

from typing import Any, Literal

CONTRACT_STATUS = "MOCK_AWAITING_AGENT1"
CONTRACT_VERSION = "MOCK-1"

ReducerName = Literal[
    "create_incident",
    "update_incident",
    "transition_incident_status",
    "add_asset",
    "update_asset_status",
    "add_service_dependency",
    "add_operational_impact",
    "update_data_scope",
    "create_task",
    "assign_task",
    "update_task_status",
    "approve_task",
    "reject_task",
    "send_message",
    "invite_member",
    "revoke_member",
    "append_evidence_reference",
    "create_agent_run",
    "record_agent_result",
]

REQUIRED_READ_ENDPOINTS: dict[str, str] = {
    "authorize_incident": "POST /internal/v1/authorize",
    "get_incident": "GET /internal/v1/incidents/{incident_id}",
    "get_assets": "GET /internal/v1/incidents/{incident_id}/assets",
    "get_dependencies": "GET /internal/v1/incidents/{incident_id}/dependencies",
    "get_open_tasks": "GET /internal/v1/incidents/{incident_id}/tasks?status=open",
    "get_evidence_summaries": "GET /internal/v1/incidents/{incident_id}/evidence/summaries",
    "submit_pending_recommendation": "POST /internal/v1/incidents/{incident_id}/recommendations",
    "ready": "GET /internal/v1/ready",
}

REQUIRED_REDUCERS: tuple[ReducerName, ...] = (
    "create_agent_run",
    "record_agent_result",
    "create_task",
    "approve_task",
)

# The AI service must never call approve_task or any status transition reducer.
AI_FORBIDDEN_REDUCERS: tuple[str, ...] = (
    "approve_task",
    "reject_task",
    "transition_incident_status",
    "update_task_status",
    "update_asset_status",
    "update_data_scope",
    "send_message",
    "revoke_member",
)

AuthorizationRequest = dict[str, Any]  # subject, organization_id, incident_id, action
AuthorizationResponse = dict[str, Any]  # allowed, role, incident
RecommendationSubmission = dict[str, Any]  # approval_status MUST be PENDING_HUMAN_APPROVAL


class RealBackendAdapterNotImplemented(RuntimeError):
    pass
