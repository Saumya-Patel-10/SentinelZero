"""Incident backends for the SentinelZero AI service.

``SpacetimeDBBackendClient`` is the production backend.  All calls go through the
SpacetimeDB HTTP API (POST {STDB_URI}/v1/database/{DB}/call/{name}) as documented
in docs/INTEGRATION_CONTRACT.md section 5.3 and packages/shared/src/agentContracts.ts:

* Reducers return HTTP 200 with an EMPTY body on success.
* Reducer failures return HTTP 530 with the body ``"<CODE>: <detail>"``.
* Procedures return HTTP 200 with POSITIONAL JSON (product values are arrays in
  the field order of ``AGENT_PROCEDURE_FIELDS``; arrays of products are arrays of
  arrays).  ``agent_get_*`` wrap the value in ``[0, value]`` / ``[1, "CODE: detail"]``.

Two token classes are used:

* **User token** (forwarded from the caller's bearer header, never logged):
  ``verify_agent_run_access`` only.  SpacetimeDB checks active membership/role.
* **Service-principal token** (``AI_BACKEND_SERVICE_TOKEN``): all agent
  reducers/procedures -- claim, reads, submit, complete.

``SimulatorBackendClient`` is a local, non-production backend over the
deterministic simulator state (EXERCISE data only).  It is refused in production.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from app.config import Settings
from app.errors import (
    ACCESS_DENIED,
    AUTH_REQUIRED,
    INCIDENT_NOT_FOUND,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    VALIDATION_FAILED,
    ApiError,
)

logger = logging.getLogger("sentinelzero.ai.backend")

CONTRACT_VERSION = "1.1.0"


# ---------------------------------------------------------------------------
# Decoded records (snake_case mirrors of the SpacetimeDB product types)
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


# Field order is the wire contract (packages/shared/src/agentContracts.ts).
AGENT_PROCEDURE_FIELDS: dict[str, tuple[str, ...]] = {
    "RunAccess": ("authorized", "isRequester", "role", "runId", "incidentId", "organizationId", "status"),
    "AgentIncident": (
        "runId", "analysisType", "incidentId", "title", "description", "category",
        "severity", "status", "dataClass", "reportedAt", "detectedAt", "updatedAt",
    ),
    "AgentAsset": (
        "id", "name", "assetType", "criticality", "compromiseStatus",
        "availabilityStatus", "lastVerifiedAt", "dataScopes",
    ),
    "AgentDataScope": (
        "id", "dataCategory", "sensitivity", "lockStatus", "exfiltrationStatus",
        "integrityStatus", "estimatedRecords", "confidence", "evidenceId",
    ),
    "AgentDependencyGraph": ("services", "dependencies", "impacts"),
    "AgentService": ("id", "name", "criticality", "availabilityStatus", "availabilityVerification"),
    "AgentDependency": ("id", "sourceAssetId", "targetServiceId", "dependencyType", "verification"),
    "AgentImpact": ("id", "serviceId", "impactType", "severity", "verification", "affectedGroup", "description"),
    "AgentTask": ("id", "title", "priority", "status", "approvalStatus", "source", "assigned"),
    "AgentEvidence": ("id", "evidenceType", "source", "sha256", "classification", "description", "recordedAt"),
}

_NESTED: dict[str, dict[str, str]] = {
    "AgentAsset": {"dataScopes": "AgentDataScope"},
    "AgentDependencyGraph": {
        "services": "AgentService",
        "dependencies": "AgentDependency",
        "impacts": "AgentImpact",
    },
}

_BOOL_FIELDS = {"authorized", "isRequester", "assigned"}
_MAX_DECODE_ITEMS = 500
_MAX_FIELD_CHARS = 20_000


def _snake(name: str) -> str:
    out = []
    for ch in name:
        if ch.isupper():
            out.append("_")
            out.append(ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def _malformed(record: str) -> ApiError:
    return ApiError(503, SERVICE_UNAVAILABLE, f"The incident backend returned a malformed {record}.")


def decode_record(record: str, value: Any) -> dict[str, Any]:
    """Decode one SpacetimeDB product value into a snake_case dict.

    Accepts the positional array the HTTP API returns, or a named object with
    camelCase (or snake_case) keys.  Anything else is a protocol violation.
    """
    fields = AGENT_PROCEDURE_FIELDS[record]
    if isinstance(value, list):
        if len(value) != len(fields):
            raise _malformed(record)
        raw = dict(zip(fields, value))
    elif isinstance(value, dict):
        raw = {}
        for field_name in fields:
            if field_name in value:
                raw[field_name] = value[field_name]
            elif _snake(field_name) in value:
                raw[field_name] = value[_snake(field_name)]
            else:
                raise _malformed(record)
    else:
        raise _malformed(record)

    out: dict[str, Any] = {}
    nested = _NESTED.get(record, {})
    for field_name in fields:
        item = raw[field_name]
        if field_name in nested:
            if not isinstance(item, list) or len(item) > _MAX_DECODE_ITEMS:
                raise _malformed(record)
            out[_snake(field_name)] = [decode_record(nested[field_name], v) for v in item]
        elif field_name in _BOOL_FIELDS:
            if not isinstance(item, bool):
                raise _malformed(record)
            out[_snake(field_name)] = item
        else:
            if item is None:
                item = ""
            if isinstance(item, bool) or not isinstance(item, (str, int, float)):
                raise _malformed(record)
            out[_snake(field_name)] = str(item)[:_MAX_FIELD_CHARS]
    return out


def decode_list(record: str, value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > _MAX_DECODE_ITEMS:
        raise _malformed(record)
    return [decode_record(record, item) for item in value]


def _incident(value: Any) -> AgentIncident:
    return AgentIncident(**decode_record("AgentIncident", value))


def _graph(value: Any) -> AgentDependencyGraph:
    data = decode_record("AgentDependencyGraph", value)
    return AgentDependencyGraph(
        services=[AgentService(**s) for s in data["services"]],
        dependencies=[AgentDependency(**d) for d in data["dependencies"]],
        impacts=[AgentImpact(**i) for i in data["impacts"]],
    )


def _run_access(value: Any) -> RunAccess:
    data = decode_record("RunAccess", value)
    return RunAccess(
        authorized=data["authorized"],
        is_requester=data["is_requester"],
        role=data["role"] or None,
        run_id=data["run_id"],
        incident_id=data["incident_id"],
        organization_id=data["organization_id"],
        status=data["status"],
    )


# ---------------------------------------------------------------------------
# Backend protocol
# ---------------------------------------------------------------------------


class BackendClient(Protocol):
    """Structural protocol shared by every incident backend."""

    mode: str
    contract_version: str

    async def ready(self) -> bool: ...
    async def verify_agent_run_access(self, user_token: str, run_id: str) -> RunAccess: ...
    async def agent_claim_run(self, run_id: str, model_identifier: str, inference_mode: str) -> None: ...
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
        self, *, run_id: str, status: str, error_category: str, summary: str
    ) -> None: ...
    async def aclose(self) -> None: ...


# ---------------------------------------------------------------------------
# SpacetimeDB HTTP client
# ---------------------------------------------------------------------------


_TYPED_CODES: dict[str, tuple[int, str]] = {
    "INCIDENT_NOT_FOUND": (404, INCIDENT_NOT_FOUND),
    "NOT_FOUND": (404, INCIDENT_NOT_FOUND),
    "ACCESS_DENIED": (403, ACCESS_DENIED),
    "AUTH_REQUIRED": (401, AUTH_REQUIRED),
    "RATE_LIMITED": (429, RATE_LIMITED),
    "VALIDATION_FAILED": (422, VALIDATION_FAILED),
    "INVALID_TRANSITION": (409, "INVALID_TRANSITION"),
    "VERSION_CONFLICT": (409, "VERSION_CONFLICT"),
}


def _typed_error(text: str, *, context: str) -> ApiError:
    code, detail = _parse_530(text)
    detail = detail[:300] or "The incident backend rejected the request."
    if code in _TYPED_CODES:
        status, api_code = _TYPED_CODES[code]
        headers = {"Retry-After": "5"} if status == 429 else None
        return ApiError(status, api_code, detail, headers=headers)
    return ApiError(503, SERVICE_UNAVAILABLE, f"The incident backend failed ({context}).")


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
        """Ready when a service-principal token is configured (no network round trip)."""
        return bool(self._service_token)

    @staticmethod
    def _headers(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async def _post_json(self, name: str, args: list[Any], *, user_token: str | None = None) -> Any:
        token = user_token if user_token is not None else self._service_token
        if not token:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is not configured.")
        try:
            response = await self._client.post(
                f"/{quote(name, safe='')}", json=args, headers=self._headers(token)
            )
        except httpx.HTTPError as exc:
            logger.error("stdb_call_failed name=%s error=%s", name, type(exc).__name__)
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unreachable.") from exc

        status = response.status_code
        if 200 <= status < 300:
            # Reducers succeed with an empty body; procedures return JSON.
            if not response.content or not response.content.strip():
                return None
            try:
                return response.json()
            except ValueError as exc:
                raise ApiError(
                    503, SERVICE_UNAVAILABLE, "The incident backend returned invalid data."
                ) from exc

        text = response.text.strip()[:1000]
        if status == 401:
            raise ApiError(401, AUTH_REQUIRED, "The incident backend rejected the caller token.")
        if status == 403:
            if text.startswith("AUTH_REQUIRED"):
                raise ApiError(401, AUTH_REQUIRED, "The incident backend rejected the caller token.")
            raise ApiError(403, ACCESS_DENIED, "The incident backend denied access.")
        if status == 404:
            raise ApiError(404, INCIDENT_NOT_FOUND, "The referenced record was not found.")
        if status == 429:
            raise ApiError(
                429,
                RATE_LIMITED,
                "The incident backend is rate limiting requests.",
                headers={"Retry-After": response.headers.get("retry-after", "5")[:4]},
            )
        if status == 530:
            raise _typed_error(text, context=name)
        logger.error("stdb_call_unexpected_status name=%s status=%s", name, status)
        raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unavailable.")

    async def _procedure_result(self, name: str, run_id: str) -> Any:
        """Call an agent_get_* procedure and unwrap its [tag, value] envelope."""
        data = await self._post_json(name, [run_id])
        if not isinstance(data, list) or len(data) != 2 or data[0] not in (0, 1):
            raise _malformed(f"result for {name}")
        tag, payload = data
        if tag == 0:
            return payload
        raise _typed_error(str(payload), context=name)

    # --- user-token call --------------------------------------------------

    async def verify_agent_run_access(self, user_token: str, run_id: str) -> RunAccess:
        data = await self._post_json("verify_agent_run_access", [run_id], user_token=user_token)
        return _run_access(data)

    # --- service-token calls ----------------------------------------------

    async def agent_claim_run(self, run_id: str, model_identifier: str, inference_mode: str) -> None:
        await self._post_json("agent_claim_run", [run_id, model_identifier, inference_mode])

    async def agent_get_incident(self, run_id: str) -> AgentIncident:
        return _incident(await self._procedure_result("agent_get_incident", run_id))

    async def agent_get_assets(self, run_id: str) -> list[AgentAsset]:
        value = await self._procedure_result("agent_get_assets", run_id)
        return [AgentAsset(**item) for item in decode_list("AgentAsset", value)]

    async def agent_get_dependencies(self, run_id: str) -> AgentDependencyGraph:
        return _graph(await self._procedure_result("agent_get_dependencies", run_id))

    async def agent_get_open_tasks(self, run_id: str) -> list[AgentTask]:
        value = await self._procedure_result("agent_get_open_tasks", run_id)
        return [AgentTask(**item) for item in decode_list("AgentTask", value)]

    async def agent_get_evidence_summaries(self, run_id: str) -> list[AgentEvidence]:
        value = await self._procedure_result("agent_get_evidence_summaries", run_id)
        return [AgentEvidence(**item) for item in decode_list("AgentEvidence", value)]

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
        # The reducer returns an empty body; the recommendation id is read back by
        # the browser from my_recommendations.  The client key is the stable handle.
        if isinstance(data, str) and data:
            return data[:64]
        return client_key[:64]

    async def agent_complete_run(
        self, *, run_id: str, status: str, error_category: str, summary: str
    ) -> None:
        await self._post_json("agent_complete_run", [run_id, status, error_category, summary])

    async def aclose(self) -> None:
        await self._client.aclose()


def _parse_530(text: str) -> tuple[str, str]:
    """Parse a typed error body of the form ``"<CODE>: <detail>"``."""
    parts = text.split(":", 1)
    if len(parts) == 2 and parts[0].strip().replace("_", "").isalpha() and parts[0].strip().isupper():
        return parts[0].strip(), parts[1].strip()
    return "UNKNOWN", text


# ---------------------------------------------------------------------------
# Local simulator backend (development / test / red-team only)
# ---------------------------------------------------------------------------


_ANALYSIS_ROLES = frozenset({"OWNER", "COMMANDER", "ANALYST"})
_VIEW_ROLES = frozenset({"OWNER", "COMMANDER", "ANALYST", "RESPONDER", "OBSERVER"})
_TASK_PRIORITY = {"CRITICAL": "P1", "HIGH": "P2", "MEDIUM": "P3", "LOW": "P4"}
_CLASSIFICATION = {"SENSITIVE": "CONFIDENTIAL"}
_MAX_SIM_RUNS = 1_000
_MAX_SIM_RECOMMENDATIONS_PER_RUN = 10


@dataclass
class _SimRun:
    run_id: str
    organization_id: str
    incident_id: str
    requested_by: str
    analysis_type: str
    status: str = "REQUESTED"
    model_identifier: str = ""
    inference_mode: str = ""
    error_category: str = "NONE"
    summary: str = ""


class SimulatorBackendClient:
    """Backend over the deterministic simulator state file (EXERCISE data only).

    It mirrors the SpacetimeDB authorization semantics the service relies on:
    caller tokens are verified locally (HS256, issuer, audience) and mapped to
    simulator memberships; runs must be REQUESTED by the caller before analysis;
    agent reads require a claimed RUNNING run; submissions are PENDING only.
    Refused in production by ``Settings``.
    """

    mode = "simulator"
    contract_version = CONTRACT_VERSION

    def __init__(self, settings: Settings, *, state: dict[str, Any] | None = None) -> None:
        self._settings = settings
        self._state = state
        self._runs: dict[str, _SimRun] = {}
        self._recommendations: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    # --- state ------------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        if self._state is None:
            from simulator.store import read_state

            path = self._settings.simulator_state_path
            self._state = read_state(Path(path) if path else None)
        return self._state

    async def ready(self) -> bool:
        try:
            state = self._load()
        except (OSError, ValueError):
            return False
        return bool(state.get("incidents")) and self._settings.jwt_secret is not None

    # --- identity -----------------------------------------------------------

    def _subject(self, user_token: str) -> str:
        import jwt

        if self._settings.jwt_secret is None:
            raise ApiError(503, SERVICE_UNAVAILABLE, "Simulator authentication is not configured.")
        try:
            claims = jwt.decode(
                user_token,
                self._settings.jwt_secret.get_secret_value(),
                algorithms=["HS256"],
                audience=self._settings.jwt_audience,
                issuer=self._settings.jwt_issuer,
                leeway=self._settings.jwt_leeway_seconds,
                options={"require": ["exp", "iat", "sub", "iss", "aud"]},
            )
        except jwt.PyJWTError as exc:
            raise ApiError(401, AUTH_REQUIRED, "The caller token was rejected.") from exc
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise ApiError(401, AUTH_REQUIRED, "The caller token was rejected.")
        return subject

    def _role(self, subject: str, organization_id: str) -> str | None:
        state = self._load()
        disabled = {
            u.get("auth_identity") for u in state.get("users", []) if u.get("disabled_at")
        }
        if subject in disabled:
            return None
        for member in state.get("memberships", []):
            if (
                member.get("user_identity") == subject
                and member.get("organization_id") == organization_id
                and not member.get("revoked_at")
            ):
                return str(member.get("role"))
        return None

    def _incident_row(self, incident_id: str) -> dict[str, Any] | None:
        return next(
            (i for i in self._load().get("incidents", []) if i.get("id") == incident_id), None
        )

    # --- human-facing (mirrors request_agent_run) -------------------------

    async def request_agent_run(self, user_token: str, incident_id: str, analysis_type: str) -> str:
        subject = self._subject(user_token)
        incident = self._incident_row(incident_id)
        if incident is None:
            raise ApiError(404, INCIDENT_NOT_FOUND, "Incident was not found.")
        role = self._role(subject, str(incident.get("organization_id")))
        if role not in _ANALYSIS_ROLES:
            # Same response for non-members and under-privileged members.
            raise ApiError(404, INCIDENT_NOT_FOUND, "Incident was not found.")
        async with self._lock:
            if len(self._runs) >= _MAX_SIM_RUNS:
                raise ApiError(429, RATE_LIMITED, "Too many simulator runs.", headers={"Retry-After": "60"})
            run_id = f"run_sim_{secrets.token_hex(8)}"
            self._runs[run_id] = _SimRun(
                run_id=run_id,
                organization_id=str(incident.get("organization_id")),
                incident_id=incident_id,
                requested_by=subject,
                analysis_type=analysis_type,
            )
        return run_id

    # --- BackendClient ------------------------------------------------------

    async def verify_agent_run_access(self, user_token: str, run_id: str) -> RunAccess:
        subject = self._subject(user_token)
        denied = RunAccess(False, False, None, run_id, "", "", "")
        run = self._runs.get(run_id)
        if run is None:
            return denied
        role = self._role(subject, run.organization_id)
        if role not in _VIEW_ROLES:
            return denied
        return RunAccess(
            authorized=True,
            is_requester=run.requested_by == subject,
            role=role,
            run_id=run_id,
            incident_id=run.incident_id,
            organization_id=run.organization_id,
            status=run.status,
        )

    def _service_run(self, run_id: str) -> _SimRun:
        run = self._runs.get(run_id)
        if run is None:
            raise ApiError(404, INCIDENT_NOT_FOUND, "agent run not found")
        if run.status != "RUNNING":
            raise ApiError(409, "INVALID_TRANSITION", f"agent run is {run.status}")
        if self._role(run.requested_by, run.organization_id) not in _ANALYSIS_ROLES:
            raise ApiError(403, ACCESS_DENIED, "requesting user no longer has access")
        return run

    async def agent_claim_run(self, run_id: str, model_identifier: str, inference_mode: str) -> None:
        if inference_mode not in {"LIVE", "SIMULATED", "FIXTURE"}:
            raise ApiError(422, VALIDATION_FAILED, "invalid inferenceMode")
        async with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                raise ApiError(404, INCIDENT_NOT_FOUND, "agent run not found")
            if run.status == "RUNNING":
                return
            if run.status != "REQUESTED":
                raise ApiError(409, "INVALID_TRANSITION", f"agent run is {run.status}")
            run.status = "RUNNING"
            run.model_identifier = model_identifier[:200]
            run.inference_mode = inference_mode

    async def agent_get_incident(self, run_id: str) -> AgentIncident:
        run = self._service_run(run_id)
        i = self._incident_row(run.incident_id) or {}
        return AgentIncident(
            run_id=run.run_id,
            analysis_type=run.analysis_type,
            incident_id=run.incident_id,
            title=str(i.get("title", "")),
            description=str(i.get("description", "")),
            category=str(i.get("category", "")),
            severity=str(i.get("severity", "")),
            status=str(i.get("status", "")),
            data_class=str(i.get("exercise_label", "EXERCISE")),
            reported_at=str(i.get("reported_at", "")),
            detected_at=str(i.get("detected_at", "")),
            updated_at=str(i.get("updated_at", "")),
        )

    async def agent_get_assets(self, run_id: str) -> list[AgentAsset]:
        run = self._service_run(run_id)
        state = self._load()
        scopes = [s for s in state.get("data_scopes", []) if s.get("incident_id") == run.incident_id]
        out = []
        for a in state.get("assets", []):
            if a.get("incident_id") != run.incident_id:
                continue
            out.append(
                AgentAsset(
                    id=str(a.get("id")),
                    name=str(a.get("name", "")),
                    asset_type=str(a.get("type", "")),
                    criticality=str(a.get("criticality", "")),
                    compromise_status=str(a.get("compromise_status", "UNKNOWN")),
                    availability_status=str(a.get("availability_status", "UNKNOWN")),
                    last_verified_at=str(a.get("last_verified_at", "")),
                    data_scopes=[
                        {
                            "id": str(s.get("id")),
                            "data_category": str(s.get("data_category", "")),
                            "sensitivity": str(s.get("sensitivity", "")),
                            "lock_status": str(s.get("lock_status", "")),
                            "exfiltration_status": str(s.get("exfiltration_status", "UNKNOWN")),
                            "integrity_status": str(s.get("integrity_status", "UNKNOWN")),
                            "estimated_records": str(s.get("estimated_records", "")),
                            "confidence": str(s.get("confidence", "")),
                            "evidence_id": str(s.get("evidence_reference", "")),
                        }
                        for s in scopes
                        if s.get("asset_id") == a.get("id")
                    ],
                )
            )
        return out

    async def agent_get_dependencies(self, run_id: str) -> AgentDependencyGraph:
        run = self._service_run(run_id)
        state = self._load()
        services = [
            AgentService(
                id=str(s.get("id")),
                name=str(s.get("name", "")),
                criticality=str(s.get("criticality", "")),
                availability_status=str(s.get("status", "UNKNOWN")),
                availability_verification=str(s.get("verification_status", "UNKNOWN")),
            )
            for s in state.get("services", [])
            if s.get("organization_id") == run.organization_id
        ]
        dependencies = [
            AgentDependency(
                id=str(d.get("id")),
                source_asset_id=str(d.get("source_asset_id", "")),
                target_service_id=str(d.get("target_service_id", "")),
                dependency_type=str(d.get("type", "")),
                verification="CONFIRMED" if d.get("verified_at") else "UNKNOWN",
            )
            for d in state.get("service_dependencies", [])
            if d.get("organization_id") == run.organization_id
        ]
        impacts = [
            AgentImpact(
                id=str(i.get("id")),
                service_id=str(i.get("service_id", "")),
                impact_type=str(i.get("impact_type", i.get("type", ""))),
                severity=str(i.get("severity", "")),
                verification=str(i.get("verification_status", i.get("verification", "UNKNOWN"))),
                affected_group=str(i.get("affected_group", "")),
                description=str(i.get("description", "")),
            )
            for i in state.get("operational_impacts", [])
            if i.get("incident_id", run.incident_id) == run.incident_id
        ]
        return AgentDependencyGraph(services=services, dependencies=dependencies, impacts=impacts)

    async def agent_get_open_tasks(self, run_id: str) -> list[AgentTask]:
        run = self._service_run(run_id)
        return [
            AgentTask(
                id=str(t.get("id")),
                title=str(t.get("title", "")),
                priority=_TASK_PRIORITY.get(str(t.get("priority")), str(t.get("priority", ""))),
                status=str(t.get("status", "")),
                approval_status=str(t.get("approval_status", "")),
                source=str(t.get("source", "HUMAN")),
                assigned=t.get("assigned_identity") is not None,
            )
            for t in self._load().get("tasks", [])
            if t.get("incident_id") == run.incident_id
            and t.get("status") not in {"COMPLETED", "CANCELLED"}
        ]

    async def agent_get_evidence_summaries(self, run_id: str) -> list[AgentEvidence]:
        run = self._service_run(run_id)
        return [
            AgentEvidence(
                id=str(e.get("id")),
                evidence_type=str(e.get("type", "")),
                source=str(e.get("source", "")),
                sha256=str(e.get("sha256", "")),
                classification=_CLASSIFICATION.get(str(e.get("classification")), str(e.get("classification", ""))),
                description=str(e.get("description", "")),
                recorded_at=str(e.get("recorded_at", "")),
            )
            for e in self._load().get("evidence_references", [])
            if e.get("incident_id") == run.incident_id
        ]

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
        async with self._lock:
            run = self._service_run(run_id)
            if priority not in {"P1", "P2", "P3", "P4"}:
                raise ApiError(422, VALIDATION_FAILED, "invalid priority")
            if not evidence_ids and not uncertainties:
                raise ApiError(422, VALIDATION_FAILED, "a recommendation must cite evidence or state its uncertainties")
            known = {
                e.get("id")
                for e in self._load().get("evidence_references", [])
                if e.get("incident_id") == run.incident_id
            }
            if any(eid not in known for eid in evidence_ids):
                raise ApiError(422, VALIDATION_FAILED, "evidence does not belong to this incident")
            key = f"{run_id}:{client_key}"
            if key in self._recommendations:
                return self._recommendations[key]["id"]
            if sum(1 for r in self._recommendations.values() if r["run_id"] == run_id) >= _MAX_SIM_RECOMMENDATIONS_PER_RUN:
                raise ApiError(429, RATE_LIMITED, "too many recommendations for this run", headers={"Retry-After": "60"})
            rec_id = "rec_sim_" + hashlib.sha256(key.encode()).hexdigest()[:16]
            self._recommendations[key] = {
                "id": rec_id,
                "run_id": run_id,
                "status": "PENDING",
                "title": title,
                "priority": priority,
                "evidence_ids": list(evidence_ids),
                "inference_mode": run.inference_mode,
            }
            return rec_id

    async def agent_complete_run(
        self, *, run_id: str, status: str, error_category: str, summary: str
    ) -> None:
        if status not in {"COMPLETED", "FAILED"}:
            raise ApiError(422, VALIDATION_FAILED, "invalid status")
        if status == "COMPLETED" and error_category != "NONE":
            raise ApiError(422, VALIDATION_FAILED, "COMPLETED runs must use errorCategory NONE")
        async with self._lock:
            run = self._service_run(run_id)
            run.status = status
            run.error_category = error_category
            run.summary = summary[:5000]

    def recommendations_for(self, run_id: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self._recommendations.values() if r["run_id"] == run_id]

    async def aclose(self) -> None:
        return None


def make_backend(settings: Settings) -> BackendClient:
    if settings.backend_mode == "simulator":
        return SimulatorBackendClient(settings)
    return SpacetimeDBBackendClient(settings)


def assert_pending_only(approval_status: str) -> None:
    """Final guard: never let a submission carry an approval decision."""
    if approval_status != "PENDING":
        raise ApiError(500, SERVICE_UNAVAILABLE, "Internal approval-state violation.")
