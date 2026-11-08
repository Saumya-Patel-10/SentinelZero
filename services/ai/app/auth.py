"""Caller authentication for the AI service.

Authorization is delegated to SpacetimeDB's ``verify_agent_run_access`` procedure,
which is called with the caller's bearer token (forwarded, never logged).  The
procedure checks active membership and role server-side and returns
``authorized=false`` without disclosing why.

The AI service never authorizes from JWT ``org_id`` or ``roles`` claims -- those
claims are not issued or checked by SpacetimeDB (see
docs/INTEGRATION_CONTRACT.md section 5.4).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import Request

from app.backend import BackendClient
from app.config import Settings
from app.errors import ACCESS_DENIED, AUTH_REQUIRED, SERVICE_UNAVAILABLE, ApiError

logger = logging.getLogger("sentinelzero.ai.auth")

ANALYSIS_ROLES = frozenset({"OWNER", "COMMANDER", "ANALYST"})
DECIDE_RECOMMENDATION_ROLES = frozenset({"OWNER", "COMMANDER"})


@dataclass(frozen=True)
class RunAccess:
    """Result of verify_agent_run_access for a specific run."""

    authorized: bool
    is_requester: bool
    role: str | None
    run_id: str
    incident_id: str
    organization_id: str
    status: str

    @property
    def can_analyze(self) -> bool:
        return self.authorized and self.is_requester and self.status == "REQUESTED"

    @property
    def can_read_run(self) -> bool:
        return self.authorized

    @property
    def can_cancel(self) -> bool:
        return self.authorized and (
            self.is_requester or (self.role or "") in DECIDE_RECOMMENDATION_ROLES
        )


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _backend(request: Request) -> BackendClient:
    return request.app.state.backend


def extract_bearer_token(request: Request) -> str:
    """Extract and validate the presence of a bearer token from the request.

    The token itself is forwarded to SpacetimeDB for verification; it is not
    decoded or trusted here.
    """
    authorization = request.headers.get("authorization")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ApiError(
            401,
            AUTH_REQUIRED,
            "A bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[len("Bearer "):]


async def verify_run_access(
    run_id: str,
    request: Request,
) -> RunAccess:
    """Verify the caller's access to a run via SpacetimeDB.

    Extracts the bearer token from the request and forwards it to
    ``verify_agent_run_access``.  Returns the access decision.  Raises 401 if
    authentication is not configured or the token is missing; returns
    authorized=false as a RunAccess value when SpacetimeDB denies access.
    """
    settings = _settings(request)
    backend = _backend(request)

    token = extract_bearer_token(request)

    if not settings.backend_service_token:
        raise ApiError(
            503,
            SERVICE_UNAVAILABLE,
            "Backend authorization is not configured.",
            details={"category": "BACKEND_NOT_CONFIGURED"},
        )

    try:
        result = await backend.verify_agent_run_access(token, run_id)
        return RunAccess(
            authorized=result.authorized,
            is_requester=result.is_requester,
            role=result.role,
            run_id=result.run_id,
            incident_id=result.incident_id,
            organization_id=result.organization_id,
            status=result.status,
        )
    except ApiError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("verify_run_access_failed run_id=%s", run_id)
        raise ApiError(
            503,
            SERVICE_UNAVAILABLE,
            "Unable to verify run access.",
        ) from exc


def require_authorized(access: RunAccess, *, action: str) -> None:
    if not access.authorized:
        raise ApiError(403, ACCESS_DENIED, f"Access denied for {action}.")


def require_can_analyze(access: RunAccess) -> None:
    if not access.can_analyze:
        raise ApiError(
            403,
            ACCESS_DENIED,
            "You must be the requester of a REQUESTED run to start analysis.",
        )


def require_can_read_run(access: RunAccess) -> None:
    if not access.can_read_run:
        raise ApiError(403, ACCESS_DENIED, "You are not authorized to read this run.")


def require_can_cancel(access: RunAccess) -> None:
    if not access.can_cancel:
        raise ApiError(403, ACCESS_DENIED, "Only the requester or a commander may cancel this run.")


# ---------------------------------------------------------------------------
# TEST / DEMO ONLY token minting. Never called by the service at runtime.
# ---------------------------------------------------------------------------
def mint_test_token(
    *,
    secret: str,
    subject: str,
    organization_id: str,
    roles: list[str],
    issuer: str = "sentinelzero-auth",
    audience: str = "sentinelzero-ai",
    ttl_seconds: int = 900,
    display_name: str | None = None,
) -> str:
    """Mint an HS256 JWT for local tests and demos only.

    The token is verified by SpacetimeDB's host (issuer policy) at connect time;
    the AI service forwards it to verify_agent_run_access.  This helper exists
    so tests can generate tokens without a real OIDC provider.
    """
    import jwt
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "org_id": organization_id,
        "roles": roles,
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": now + timedelta(seconds=ttl_seconds),
        "jti": f"test-{now.timestamp():.0f}",
    }
    if display_name:
        payload["name"] = display_name
    return jwt.encode(payload, secret, algorithm="HS256")
