"""Incident backend adapters.

Agent 1 has not published a backend contract in this repository yet. This module
therefore defines a deliberately narrow typed interface and two implementations:

* ``MemoryBackendClient`` -- reads the synthetic simulator state file. MOCK.
* ``HttpBackendClient``   -- proposed Agent 1 HTTP contract. MOCK / UNVERIFIED.

Both are read-only except ``submit_recommendation``, which submits a proposal with
``approval_status=PENDING_HUMAN_APPROVAL``. No approval endpoint exists here.

Exact expected Agent 1 contract (version MOCK-1) is documented in
docs/deployment.md. Replace ``HttpBackendClient`` paths only after the published
contract is frozen; do not silently reinterpret it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from app.auth import ANALYSIS_ROLES, READ_RUN_ROLES, Principal
from app.config import Settings
from app.errors import (
    ACCESS_DENIED,
    AI_BACKEND_NOT_READY,
    INCIDENT_NOT_FOUND,
    SERVICE_UNAVAILABLE,
    ApiError,
)
from app.schemas import (
    AssetContext,
    AuthorizationDecision,
    DataScopeContext,
    EvidenceSummary,
    IncidentContext,
    OperationalImpactContext,
    Recommendation,
    ServiceContext,
    ServiceDependencyContext,
    TaskContext,
)

CONTRACT_VERSION = "MOCK-1"
_OPEN_TASK_STATES = {"PENDING", "AWAITING_APPROVAL", "IN_PROGRESS", "BLOCKED"}
_ACTION_ROLES = {
    "ai.analyze": ANALYSIS_ROLES,
    "ai.submit_recommendation": ANALYSIS_ROLES,
    "ai.read_run": READ_RUN_ROLES,
    "ai.cancel_run": READ_RUN_ROLES,
    "ai.read_context": READ_RUN_ROLES,
}


@dataclass
class DependencyView:
    dependencies: list[ServiceDependencyContext]
    services: list[ServiceContext]
    impacts: list[OperationalImpactContext]
    data_scopes: list[DataScopeContext]


class BackendClient(Protocol):
    mode: str
    contract_version: str

    async def ready(self) -> bool: ...

    async def authorize_incident(
        self, principal: Principal, incident_id: str, action: str
    ) -> AuthorizationDecision: ...

    async def get_incident(self, incident_id: str) -> IncidentContext: ...

    async def get_assets(self, incident_id: str) -> list[AssetContext]: ...

    async def get_dependencies(self, incident_id: str) -> DependencyView: ...

    async def get_open_tasks(self, incident_id: str) -> list[TaskContext]: ...

    async def get_evidence_summaries(self, incident_id: str) -> list[EvidenceSummary]: ...

    async def submit_recommendation(
        self,
        *,
        recommendation: Recommendation,
        requested_by: str,
        idempotency_key: str,
    ) -> str: ...

    async def aclose(self) -> None: ...


def _model_list(model: type, records: list[Any], *, limit: int = 50) -> list[Any]:
    out = []
    for record in records[:limit]:
        if isinstance(record, dict):
            out.append(model.model_validate(record))
    return out


class MemoryBackendClient:
    """MOCK incident backend backed by deterministic simulator state."""

    mode = "memory"
    contract_version = CONTRACT_VERSION

    def __init__(self, *, state_path: Path | None = None, state: dict | None = None) -> None:
        self._state_path = state_path
        self._static_state = state
        self._cached_state: dict | None = None
        self._cached_mtime: float | None = None
        self._lock = asyncio.Lock()
        self._submissions: dict[str, tuple[str, dict]] = {}

    async def ready(self) -> bool:
        try:
            await self._load()
            return True
        except ApiError:
            return False

    async def _load(self) -> dict:
        async with self._lock:
            if self._static_state is not None:
                return self._static_state
            if self._state_path is None:
                raise ApiError(
                    503,
                    SERVICE_UNAVAILABLE,
                    "The exercise incident backend is not configured.",
                    details={"category": AI_BACKEND_NOT_READY},
                )
            try:
                mtime = self._state_path.stat().st_mtime
            except OSError as exc:
                raise ApiError(
                    503,
                    SERVICE_UNAVAILABLE,
                    "The exercise incident backend is not seeded. Run the simulator reset command.",
                    details={"category": AI_BACKEND_NOT_READY},
                ) from exc
            if self._cached_state is not None and self._cached_mtime == mtime:
                return self._cached_state
            try:
                raw = self._state_path.read_text(encoding="utf-8")
                state = json.loads(raw)
            except (OSError, json.JSONDecodeError) as exc:
                raise ApiError(
                    503,
                    SERVICE_UNAVAILABLE,
                    "The exercise incident backend state is unreadable.",
                    details={"category": AI_BACKEND_NOT_READY},
                ) from exc
            if not isinstance(state, dict) or not isinstance(state.get("assets"), list):
                raise ApiError(
                    503,
                    SERVICE_UNAVAILABLE,
                    "The exercise incident backend state is not valid.",
                    details={"category": AI_BACKEND_NOT_READY},
                )
            self._cached_state = state
            self._cached_mtime = mtime
            return state

    @staticmethod
    def _incidents(state: dict) -> list[dict]:
        incidents = state.get("incidents")
        if isinstance(incidents, list):
            return [i for i in incidents if isinstance(i, dict)]
        incident = state.get("incident")
        return [incident] if isinstance(incident, dict) else []

    def _find_incident(self, state: dict, incident_id: str) -> dict:
        for incident in self._incidents(state):
            if str(incident.get("id")) == incident_id:
                return incident
        raise ApiError(404, INCIDENT_NOT_FOUND, "Incident was not found.")

    async def authorize_incident(
        self, principal: Principal, incident_id: str, action: str
    ) -> AuthorizationDecision:
        state = await self._load()
        try:
            incident = self._find_incident(state, incident_id)
        except ApiError:
            # Do not reveal whether another tenant's incident exists.
            if principal.organization_id:
                return AuthorizationDecision(allowed=False, reason="Not found or not authorized.")
            raise
        if str(incident.get("organization_id")) != principal.organization_id:
            return AuthorizationDecision(allowed=False, reason="Incident is outside your organization.")
        membership = None
        for item in state.get("memberships", []):
            if (
                isinstance(item, dict)
                and item.get("user_identity") == principal.subject
                and str(item.get("organization_id")) == principal.organization_id
                and not item.get("revoked_at")
            ):
                membership = item
                break
        if membership is None:
            return AuthorizationDecision(allowed=False, reason="Active membership is required.")
        role = membership.get("role")
        allowed_roles = _ACTION_ROLES.get(action, READ_RUN_ROLES)
        if role not in allowed_roles:
            return AuthorizationDecision(
                allowed=False,
                role=role,
                reason="Role is not permitted for this AI operation.",
            )
        context = IncidentContext.model_validate(incident)
        return AuthorizationDecision(allowed=True, role=role, incident=context)

    async def _require(self, incident_id: str) -> tuple[dict, dict]:
        state = await self._load()
        return state, self._find_incident(state, incident_id)

    async def get_incident(self, incident_id: str) -> IncidentContext:
        _, incident = await self._require(incident_id)
        return IncidentContext.model_validate(incident)

    async def get_assets(self, incident_id: str) -> list[AssetContext]:
        state, _ = await self._require(incident_id)
        records = [
            a
            for a in state.get("assets", [])
            if isinstance(a, dict) and str(a.get("incident_id")) == incident_id
        ]
        records.sort(key=lambda a: str(a.get("id")))
        return _model_list(AssetContext, records)

    async def get_dependencies(self, incident_id: str) -> DependencyView:
        state, _ = await self._require(incident_id)
        org_id = None
        for incident in self._incidents(state):
            if str(incident.get("id")) == incident_id:
                org_id = str(incident.get("organization_id"))
                break
        deps = sorted(
            (d for d in state.get("service_dependencies", []) if isinstance(d, dict)),
            key=lambda d: str(d.get("id")),
        )
        services = sorted(
            (s for s in state.get("services", []) if isinstance(s, dict)),
            key=lambda s: str(s.get("id")),
        )
        impacts = sorted(
            (
                i
                for i in state.get("operational_impacts", [])
                if isinstance(i, dict) and str(i.get("incident_id")) == incident_id
            ),
            key=lambda i: str(i.get("id")),
        )
        scopes = sorted(
            (
                d
                for d in state.get("data_scopes", [])
                if isinstance(d, dict) and str(d.get("incident_id")) == incident_id
            ),
            key=lambda d: str(d.get("id")),
        )
        return DependencyView(
            dependencies=_model_list(ServiceDependencyContext, deps),
            services=_model_list(ServiceContext, services),
            impacts=_model_list(OperationalImpactContext, impacts),
            data_scopes=_model_list(DataScopeContext, scopes),
        )

    async def get_open_tasks(self, incident_id: str) -> list[TaskContext]:
        state, _ = await self._require(incident_id)
        records = [
            t
            for t in state.get("tasks", [])
            if isinstance(t, dict)
            and str(t.get("incident_id")) == incident_id
            and t.get("status") in _OPEN_TASK_STATES
        ]
        records.sort(key=lambda t: (str(t.get("priority")), str(t.get("id"))))
        return _model_list(TaskContext, records)

    async def get_evidence_summaries(self, incident_id: str) -> list[EvidenceSummary]:
        state, _ = await self._require(incident_id)
        records = [
            e
            for e in state.get("evidence_references", [])
            if isinstance(e, dict) and str(e.get("incident_id")) == incident_id
        ]
        records.sort(key=lambda e: str(e.get("id")))
        summaries = []
        for record in records[:50]:
            sha = str(record.get("sha256", ""))
            summaries.append(
                EvidenceSummary.model_validate(
                    {
                        "id": record.get("id"),
                        "organization_id": record.get("organization_id"),
                        "incident_id": record.get("incident_id"),
                        "type": record.get("type"),
                        "source": record.get("source"),
                        "sha256_prefix": sha[:16] if sha else "00000000",
                        "classification": record.get("classification"),
                        "recorded_at": record.get("recorded_at"),
                    }
                )
            )
        return summaries

    async def submit_recommendation(
        self,
        *,
        recommendation: Recommendation,
        requested_by: str,
        idempotency_key: str,
    ) -> str:
        # MOCK persistence: in-process only, lost on restart. Never approves.
        assert_pending_only(recommendation)
        payload = {
            "run_id": recommendation.run_id,
            "recommendation_id": recommendation.recommendation_id,
            "incident_id": recommendation.incident_id,
            "organization_id": recommendation.organization_id,
            "requested_by": requested_by,
            "approval_status": "PENDING_HUMAN_APPROVAL",
            "proposal": recommendation.model_dump(mode="json"),
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        signature = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        existing = self._submissions.get(idempotency_key)
        if existing is not None:
            return existing[0]
        reference = f"mock-submission-{signature[:24]}"
        self._submissions[idempotency_key] = (reference, payload)
        return reference

    async def aclose(self) -> None:
        return None


class HttpBackendClient:
    """MOCK-1 Agent 1 HTTP contract. Not validated against a real deployment."""

    mode = "http"
    contract_version = CONTRACT_VERSION

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.backend_base_url.rstrip("/"),
            timeout=settings.backend_timeout_seconds,
            transport=transport,
            follow_redirects=False,
        )

    def _headers(self) -> dict[str, str]:
        token = (
            self._settings.backend_service_token.get_secret_value()
            if self._settings.backend_service_token
            else ""
        )
        return {
            "X-Sentinel-Service-Token": token,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    async def ready(self) -> bool:
        try:
            response = await self._client.get("/internal/v1/ready", headers=self._headers())
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def _json(self, response: httpx.Response) -> Any:
        if response.status_code in (401, 403):
            raise ApiError(403, ACCESS_DENIED, "The incident backend denied access.")
        if response.status_code == 404:
            raise ApiError(404, INCIDENT_NOT_FOUND, "Incident was not found.")
        if response.status_code == 429:
            raise ApiError(
                503,
                SERVICE_UNAVAILABLE,
                "The incident backend is rate limiting requests.",
                headers={"Retry-After": response.headers.get("retry-after", "5")},
            )
        if response.status_code >= 500:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unavailable.")
        if response.status_code >= 400:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend rejected the request.")
        try:
            return response.json()
        except ValueError as exc:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend returned invalid data.") from exc

    async def _get(self, path: str) -> Any:
        try:
            response = await self._client.get(path, headers=self._headers())
        except httpx.HTTPError as exc:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unreachable.") from exc
        return await self._json(response)

    async def authorize_incident(
        self, principal: Principal, incident_id: str, action: str
    ) -> AuthorizationDecision:
        body = {
            "subject": principal.subject,
            "organization_id": principal.organization_id,
            "incident_id": incident_id,
            "action": action,
        }
        try:
            response = await self._client.post(
                "/internal/v1/authorize", json=body, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unreachable.") from exc
        data = await self._json(response)
        return AuthorizationDecision.model_validate(data)

    async def get_incident(self, incident_id: str) -> IncidentContext:
        data = await self._get(f"/internal/v1/incidents/{quote(incident_id, safe='')}")
        return IncidentContext.model_validate(data)

    async def get_assets(self, incident_id: str) -> list[AssetContext]:
        data = await self._get(f"/internal/v1/incidents/{quote(incident_id, safe='')}/assets")
        return [AssetContext.model_validate(item) for item in data]

    async def get_dependencies(self, incident_id: str) -> DependencyView:
        data = await self._get(
            f"/internal/v1/incidents/{quote(incident_id, safe='')}/dependencies"
        )
        return DependencyView(
            dependencies=[ServiceDependencyContext.model_validate(i) for i in data.get("dependencies", [])],
            services=[ServiceContext.model_validate(i) for i in data.get("services", [])],
            impacts=[OperationalImpactContext.model_validate(i) for i in data.get("impacts", [])],
            data_scopes=[DataScopeContext.model_validate(i) for i in data.get("data_scopes", [])],
        )

    async def get_open_tasks(self, incident_id: str) -> list[TaskContext]:
        data = await self._get(
            f"/internal/v1/incidents/{quote(incident_id, safe='')}/tasks?status=open"
        )
        return [TaskContext.model_validate(item) for item in data]

    async def get_evidence_summaries(self, incident_id: str) -> list[EvidenceSummary]:
        data = await self._get(
            f"/internal/v1/incidents/{quote(incident_id, safe='')}/evidence/summaries"
        )
        return [EvidenceSummary.model_validate(item) for item in data]

    async def submit_recommendation(
        self,
        *,
        recommendation: Recommendation,
        requested_by: str,
        idempotency_key: str,
    ) -> str:
        assert_pending_only(recommendation)
        body = {
            "run_id": recommendation.run_id,
            "recommendation_id": recommendation.recommendation_id,
            "incident_id": recommendation.incident_id,
            "organization_id": recommendation.organization_id,
            "requested_by": requested_by,
            "approval_status": "PENDING_HUMAN_APPROVAL",
            "idempotency_key": idempotency_key,
            "proposal": recommendation.model_dump(mode="json"),
        }
        path = (
            f"/internal/v1/incidents/{quote(recommendation.incident_id, safe='')}"
            "/recommendations"
        )
        try:
            response = await self._client.post(path, json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend is unreachable.") from exc
        data = await self._json(response)
        if not isinstance(data, dict):
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend returned invalid data.")
        if data.get("approval_status") not in (None, "PENDING_HUMAN_APPROVAL"):
            raise ApiError(
                503,
                SERVICE_UNAVAILABLE,
                "The incident backend violated the proposal-only contract.",
            )
        reference = data.get("reference") or data.get("id")
        if not isinstance(reference, str) or not reference:
            raise ApiError(503, SERVICE_UNAVAILABLE, "The incident backend returned no reference.")
        return reference[:160]

    async def aclose(self) -> None:
        await self._client.aclose()


def make_backend(settings: Settings, *, state: dict | None = None) -> BackendClient:
    if settings.backend_mode == "http":
        return HttpBackendClient(settings)
    return MemoryBackendClient(
        state_path=settings.resolved_simulator_state_path(),
        state=state,
    )


def assert_pending_only(recommendation: Recommendation) -> None:
    """Final guard: never let a submission carry an approval decision."""

    if recommendation.approval_status != "PENDING_HUMAN_APPROVAL":
        raise ApiError(500, SERVICE_UNAVAILABLE, "Internal approval-state violation.")
    for task in recommendation.proposed_tasks:
        if task.requires_human_approval is not True:
            raise ApiError(500, SERVICE_UNAVAILABLE, "Internal proposal-approval violation.")
