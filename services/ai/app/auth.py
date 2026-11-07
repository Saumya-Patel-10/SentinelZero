"""Caller authentication.

The caller is derived only from a verified JWT. Client-supplied user, role,
tenant, and approval fields are never trusted. Fine-grained incident membership
is checked independently by the backend on every run/tool/submit operation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings
from app.errors import ACCESS_DENIED, AUTH_REQUIRED, SERVICE_UNAVAILABLE, ApiError

CANONICAL_ROLES = frozenset({"OWNER", "COMMANDER", "ANALYST", "RESPONDER", "OBSERVER"})
ANALYSIS_ROLES = frozenset({"OWNER", "COMMANDER", "ANALYST"})
READ_RUN_ROLES = frozenset({"OWNER", "COMMANDER", "ANALYST", "RESPONDER"})

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    subject: str
    organization_id: str
    roles: tuple[str, ...]
    display_name: str | None = None
    token_id: str | None = None
    expires_at: datetime | None = None

    @property
    def is_analysis_authorized(self) -> bool:
        return any(role in ANALYSIS_ROLES for role in self.roles)


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _decode(token: str, settings: Settings) -> dict[str, Any]:
    if not settings.auth_configured:
        raise ApiError(
            503,
            SERVICE_UNAVAILABLE,
            "Authentication is not configured.",
            details={"category": "AUTH_NOT_CONFIGURED"},
        )
    if settings.jwt_algorithm == "RS256":
        key: Any = settings.jwt_public_key.get_secret_value() if settings.jwt_public_key else None
    else:
        key = settings.jwt_secret.get_secret_value() if settings.jwt_secret else None
    try:
        return jwt.decode(
            token,
            key=key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            leeway=settings.jwt_leeway_seconds,
            options={
                "require": ["exp", "iat", "sub", "iss", "aud"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_iat": True,
                "verify_aud": True,
                "verify_iss": True,
            },
        )
    except jwt.PyJWTError as exc:
        # Never echo the library detail; it can include attacker-controlled claims.
        raise ApiError(
            401,
            AUTH_REQUIRED,
            "Invalid or expired credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def get_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise ApiError(
            401,
            AUTH_REQUIRED,
            "A bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    settings = _settings(request)
    claims = _decode(credentials.credentials, settings)

    subject = claims.get("sub")
    organization_id = claims.get("org_id")
    raw_roles = claims.get("roles")
    if not isinstance(subject, str) or not subject.strip():
        raise ApiError(401, AUTH_REQUIRED, "Token is missing a subject.")
    if not isinstance(organization_id, str) or not organization_id.strip():
        raise ApiError(401, AUTH_REQUIRED, "Token is missing an organization.")
    if not isinstance(raw_roles, list) or not all(isinstance(r, str) for r in raw_roles):
        raise ApiError(403, ACCESS_DENIED, "Token has no recognized role.")

    roles = tuple(sorted({r.upper() for r in raw_roles if r.upper() in CANONICAL_ROLES}))
    if not roles:
        raise ApiError(403, ACCESS_DENIED, "Token has no recognized role.")

    expires_at = None
    exp = claims.get("exp")
    if isinstance(exp, (int, float)):
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)

    display_name = claims.get("name") if isinstance(claims.get("name"), str) else None
    jti = claims.get("jti") if isinstance(claims.get("jti"), str) else None

    return Principal(
        subject=subject.strip()[:200],
        organization_id=organization_id.strip()[:100],
        roles=roles,
        display_name=display_name[:200] if display_name else None,
        token_id=jti[:100] if jti else None,
        expires_at=expires_at,
    )


def require_role(principal: Principal, allowed: frozenset[str], *, action: str) -> None:
    if not any(role in allowed for role in principal.roles):
        raise ApiError(403, ACCESS_DENIED, f"Role is not permitted to {action}.")


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
