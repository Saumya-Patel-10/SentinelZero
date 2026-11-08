"""SpacetimeDB HTTP backend client for the SentinelZero AI service.

Replaces the legacy MOCK-1 ``/internal/v1/`` adapter, which targeted routes that
do not exist.  All calls go through the SpacetimeDB HTTP API
(POST {STDB_URI}/v1/database/{DB}/call/{name}) as documented in
docs/INTEGRATION_CONTRACT.md section 5.3.

Two token classes are used:

* **User token** (forwarded from the caller's bearer header, never logged):
  ``verify_agent_run_access`` only.  SpacetimeDB checks active membership/role.
* **Service-principal token** (``AI_BACKEND_SERVICE_TOKEN``): all agent
  reducers/procedures -- claim, reads, submit, complete.  The service principal
  is bound to one organization and holds no human membership.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.config import Settings
from app.errors import (
    ACCESS_DENIED,
    AUTH_REQUIRED,
    INCIDENT_NOT_FOUND,
    NOT_FOUND,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    VALIDATION_FAILED,
    ApiError,
)

logger = logging.getLogger("sentinelzero.ai.backend")

CONTRACT_VERSION = "1.1.0"


# ---------------------------------------------------------------------------
# Result envelopes returned by SpacetimeDB procedures/reducers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RunAccess:
    authorized: bool
    is_requester: bool
    role: str | None
    run_id: str
    incident_id: str
    organization_id: str
    status: str


@dataclass(frozen=True)
class AgentIncident:
    run_id: str
    analysis_type: str
    incident_id: str
    title: str
    description: str
    category: str
    severity: str
    status: str
    data_class: str
    reported_at: str
    detected_at: str
    updated_at: str


@dataclass(frozen=True)
class AgentAsset:
    id: str
    name: str
    asset_type: str
    criticality: str
    compromise_status: str
    availability_status: str
    last_verified_at: str
    data_scopes: list[dict[str, Any]]


@dataclass(frozen=True)
class AgentService:
    id: str
    name: str
    criticality: str
    availability_status: str
    availability_verification: str


@dataclass(frozen=True)
class AgentDependency:
    id: str
    source_asset_id: str
    target_service_id: str
    dependency_type: str
    verification: str


@dataclass(frozen=True)
class AgentImpact:
    id: str
    service_id: str
    impact_type: str
    severity: str
    verification: str
    affected_group: str
    description: str


@dataclass(frozen=True)
class AgentDependencyGraph:
    services: list[AgentService]
    dependencies: list[AgentDependency]
    impacts: list[AgentImpact]


@dataclass(frozen=True)
class AgentTask:
    id: str
    title: str
    priority: str
    status: str
    approval_status: str
    source: str
    assigned: bool


@dataclass(frozen=True)
class AgentEvidence:
    id: str
    evidence_type: str
    source: str
    sha256: str
    classification: str
    description: str
    recorded_at: str


class BackendClient:
    """Protocol for incident/agent backends."""

    mode: str
    contract_version: str

    async def ready(self) -> bool: ...
    async def verify_agent_run_access(
        self, user_token: str, run_id: str
    ) -> RunAccess: ...
    async def agent_claim_run(
        self, run_id: str, model_identifier: str, inference_mode: str
    ) -> None: ...
    async def agent_get_incident(self, run_id: str) -> AgentIncident: ...
    async def agent_get_assets(self, run_id: str) -> list[AgentAsset]: ...
    async def agent_get_dependencies(self, run_id: str) -> AgentDependencyGraph: ...
    async def agent_get_open_tasks(self, run_id: str) -> list[AgentTask]: ...
    async def agent_get_evidence_summaries(self, run_id: str) -> list[AgentEvidence]: ...
    async def agent_submit_recommendation(
        self,
        *,
        run_id: str,
        client_key: str,
        title: str,
        description: str,
        priority: str,
        rationale: str,
        evidence_ids: list[str],
        uncertainties: list[str],
    ) -> str: ...
    async def agent_complete_run(
        self,
        *,
        run_id: str,
        status: str,
        error_category: str,
        summary: str,
    ) -> None: ...
    async def aclose(self) -> None: ...


# ---------------------------------------------------------------------------
# SpacetimeDB HTTP client
# ---------------------------------------------------------------------------


class SpacetimeDBBackendClient:
    """Client for the SpacetimeDB HTTP API (contract v1.1.0, section 5.3)."""

    mode = "spacetimedb"
    contract_version = CONTRACT_VERSION

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._base = settings.stdb_call_base
        self._client = httpx.AsyncClient(
            base_url=self._base,
            timeout=settings.backend_timeout_seconds,
            transport=transport,
            follow_redirects=False,
        )
        self._service_token = (
            settings.backend_service_token.get_secret_value()
            if settings.backend_service_token
            else ""
        )

    async def ready(self) -> bool:
        """Backend is ready when a service-principal token is configured.

        Connectivity is validated lazily on the first call; health checks do
        not make round-trips to SpacetimeDB.
        """
        return bool(self._service_token)

    def _service_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._service_token}",
            "Content-Type": "application/json",
        }

    def _user_headers(self, user_token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {user_token}",
            "Content-Type": "application/json",
        }

    async def _post_json(
        self,
        name: str,
        args: list[Any],
        *,
        user_token: str | None = None,
    ) -> Any:
        headers = self._user_headers(user_token) if user_token is not None else self._service_headers()
        try:
            response = await self._client.post(
                f"/{quote(name, safe='')}",
                json=args,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            logger.error("stdb_call_failed name=%s error=%s", name, exc)
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unreachable.") from exc

        if response.status_code == 200:
            try:
                return response.json()
            except ValueError as exc:
                raise ApiError(
                    503, SERVICE_UNAVAILABLE, "The incident backend returned invalid data."
                ) from exc

        if response.status_code == 401:
            raise ApiError(401, AUTH_REQUIRED, "The incident backend rejected the caller token.")
        if response.status_code == 403:
            body = response.text.strip()
            raise ApiError(403, ACCESS_DENIED, body or "The incident backend denied access.")
        if response.status_code == 404:
            raise ApiError(404, INCIDENT_NOT_FOUND, "The referenced record was not found.")
        if response.status_code == 429:
            raise ApiError(
                429,
                RATE_LIMITED,
                "The incident backend is rate limiting requests.",
                headers={"Retry-After": response.headers.get("retry-after", "5")},
            )
        if response.status_code == 530:
            # Typed reducer/procedure error: "<CODE>: <detail>"
            text = response.text.strip()
            code, detail = _parse_530(text)
            if code == "INCIDENT_NOT_FOUND":
                raise ApiError(404, INCIDENT_NOT_FOUND, detail)
            if code == "ACCESS_DENIED":
                raise ApiError(403, ACCESS_DENIED, detail)
            if code == "RATE_LIMITED":
                raise ApiError(429, RATE_LIMITED, detail)
            if code == "VALIDATION_FAILED":
                raise ApiError(422, VALIDATION_FAILED, detail)
            if code == "INVALID_TRANSITION":
                raise ApiError(409, "INVALID_TRANSITION", detail)
            if code == "VERSION_CONFLICT":
                raise ApiError(409, "VERSION_CONFLICT", detail)
            raise ApiError(503, SERVICE_UNAVAILABLE, f"{code}: {detail}")
        if response.status_code >= 500:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unavailable.")
        raise ApiError(503, SERVICE_UNAVAILABLE, f"The incident backend rejected the request (HTTP {response.status_code}).")

    # ------------------------------------------------------------------
    # User-token calls
    # ------------------------------------------------------------------

    async def verify_agent_run_access(self, user_token: str, run_id: str) -> RunAccess:
        data = await self._post_json("verify_agent_run_access", [run_id], user_token=user_token)
        if not isinstance(data, list) or len(data) != 7:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend returned malformed run access.")
        authorized, is_requester, role, run_id, incident_id, organization_id, status = data
        return RunAccess(
            authorized=bool(authorized),
            is_requester=bool(is_requester),
            role=str(role) if role else None,
            run_id=str(run_id),
            incident_id=str(incident_id),
            organization_id=str(organization_id),
            status=str(status),
        )

    # ------------------------------------------------------------------
    # Service-token calls
    # ------------------------------------------------------------------

    async def agent_claim_run(
        self, run_id: str, model_identifier: str, inference_mode: str
    ) -> None:
        await self._post_json(
            "agent_claim_run",
            [run_id, model_identifier, inference_mode],
        )

    async def _decode_result(self, data: Any, tool_name: str) -> Any:
        """Decode a [tag, value] result envelope from an agent_get_* procedure.

        tag 0 => success value; tag 1 => typed denial (transaction rolled back).
        """
        if not isinstance(data, list) or len(data) != 2:
            raise ApiError(503, SERVICE_UNAVAILABLE, f"The incident backend returned a malformed result for {tool_name}.")
        tag, payload = data
        if tag == 0:
            return payload
        if tag == 1:
            text = str(payload)
            code, detail = _parse_530(text)
            if code == "ACCESS_DENIED":
                raise ApiError(403, ACCESS_DENIED, detail)
            if code == "NOT_FOUND":
                raise ApiError(404, INCIDENT_NOT_FOUND, detail)
            if code == "RATE_LIMITED":
                raise ApiError(429, RATE_LIMITED, detail)
            raise ApiError(503, SERVICE_UNAVAILABLE, f"{tool_name}: {code}: {detail}")
        raise ApiError(503, SERVICE_UNAVAILABLE, f"The incident backend returned an unknown result tag for {tool_name}.")

    async def agent_get_incident(self, run_id: str) -> AgentIncident:
        data = await self._post_json("agent_get_incident", [run_id])
        value = await self._decode_result(data, "agent_get_incident")
        return AgentIncident(**value)

    async def agent_get_assets(self, run_id: str) -> list[AgentAsset]:
        data = await self._post_json("agent_get_assets", [run_id])
        value = await self._decode_result(data, "agent_get_assets")
        return [AgentAsset(**item) for item in value]

    async def agent_get_dependencies(self, run_id: str) -> AgentDependencyGraph:
        data = await self._post_json("agent_get_dependencies", [run_id])
        value = await self._decode_result(data, "agent_get_dependencies")
        return AgentDependencyGraph(
            services=[AgentService(**s) for s in value.get("services", [])],
            dependencies=[AgentDependency(**d) for d in value.get("dependencies", [])],
            impacts=[AgentImpact(**i) for i in value.get("impacts", [])],
        )

    async def agent_get_open_tasks(self, run_id: str) -> list[AgentTask]:
        data = await self._post_json("agent_get_open_tasks", [run_id])
        value = await self._decode_result(data, "agent_get_open_tasks")
        return [AgentTask(**item) for item in value]

    async def agent_get_evidence_summaries(self, run_id: str) -> list[AgentEvidence]:
        data = await self._post_json("agent_get_evidence_summaries", [run_id])
        value = await self._decode_result(data, "agent_get_evidence_summaries")
        return [AgentEvidence(**item) for item in value]

    async def agent_submit_recommendation(
        self,
        *,
        run_id: str,
        client_key: str,
        title: str,
        description: str,
        priority: str,
        rationale: str,
        evidence_ids: list[str],
        uncertainties: list[str],
    ) -> str:
        data = await self._post_json(
            "agent_submit_recommendation",
            [run_id, client_key, title, description, priority, rationale, evidence_ids, uncertainties],
        )
        # Reducer returns HTTP 200 with empty body on success. The recommendation id is
        # not echoed by the reducer; the caller can read my_recommendations to find it.
        if data is not None and isinstance(data, str):
            return data
        return run_id

    async def agent_complete_run(
        self,
        *,
        run_id: str,
        status: str,
        error_category: str,
        summary: str,
    ) -> None:
        await self._post_json(
            "agent_complete_run",
            [run_id, status, error_category, summary],
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _parse_530(text: str) -> tuple[str, str]:
    """Parse a typed 530 error body of the form "<CODE>: <detail>."""
    parts = text.split(":", 1)
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return "UNKNOWN", text


class BackendClient:
    """Protocol for incident/agent backends (structural; not an ABC)."""

    mode: str
    contract_version: str

    async def ready(self) -> bool: ...
    async def verify_agent_run_access(
        self, user_token: str, run_id: str
    ) -> RunAccess: ...
    async def agent_claim_run(
        self, run_id: str, model_identifier: str, inference_mode: str
    ) -> None: ...
    async def agent_get_incident(self, run_id: str) -> AgentIncident: ...
    async def agent_get_assets(self, run_id: str) -> list[AgentAsset]: ...
    async def agent_get_dependencies(self, run_id: str) -> AgentDependencyGraph: ...
    async def agent_get_open_tasks(self, run_id: str) -> list[AgentTask]: ...
    async def agent_get_evidence_summaries(self, run_id: str) -> list[AgentEvidence]: ...
    async def agent_submit_recommendation(
        self,
        *,
        run_id: str,
        client_key: str,
        title: str,
        description: str,
        priority: str,
        rationale: str,
        evidence_ids: list[str],
        uncertainties: list[str],
    ) -> str: ...
    async def agent_complete_run(
        self,
        *,
        run_id: str,
        status: str,
        error_category: str,
        summary: str,
    ) -> None: ...
    async def aclose(self) -> None: ...


def make_backend(settings: Settings) -> BackendClient:
    return SpacetimeDBBackendClient(settings)


def assert_pending_only(approval_status: str) -> None:
    """Final guard: never let a submission carry an approval decision."""
    if approval_status != "PENDING":
        raise ApiError(500, SERVICE_UNAVAILABLE, "Internal approval-state violation.")
