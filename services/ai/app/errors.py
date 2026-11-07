"""Typed API errors.

Client responses never include stack traces, provider bodies, prompts, or secrets.
"""

from __future__ import annotations

from typing import Any


# Canonical error codes from ARCHITECTURE.md, plus AI-specific safe subcodes.
AUTH_REQUIRED = "AUTH_REQUIRED"
ACCESS_DENIED = "ACCESS_DENIED"
INCIDENT_NOT_FOUND = "INCIDENT_NOT_FOUND"
VALIDATION_FAILED = "VALIDATION_FAILED"
RATE_LIMITED = "RATE_LIMITED"
SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
INVALID_STATE = "INVALID_STATE"
NOT_FOUND = "NOT_FOUND"
METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
INTERNAL_ERROR = "INTERNAL_ERROR"

# AI-specific safe categories, used as ``details.category`` or run errors.
AI_PROVIDER_NOT_CONFIGURED = "AI_PROVIDER_NOT_CONFIGURED"
AI_PROVIDER_TIMEOUT = "AI_PROVIDER_TIMEOUT"
AI_PROVIDER_RATE_LIMITED = "AI_PROVIDER_RATE_LIMITED"
AI_PROVIDER_UNAVAILABLE = "AI_PROVIDER_UNAVAILABLE"
AI_PROVIDER_AUTH_FAILED = "AI_PROVIDER_AUTH_FAILED"
AI_PROVIDER_PROTOCOL_ERROR = "AI_PROVIDER_PROTOCOL_ERROR"
AI_OUTPUT_INVALID = "AI_OUTPUT_INVALID"
AI_TOOL_NOT_ALLOWED = "AI_TOOL_NOT_ALLOWED"
AI_TOOL_ARGUMENTS_INVALID = "AI_TOOL_ARGUMENTS_INVALID"
AI_TOOL_EXECUTION_FAILED = "AI_TOOL_EXECUTION_FAILED"
AI_TOOL_USE_REQUIRED = "AI_TOOL_USE_REQUIRED"
AI_STEP_LIMIT = "AI_STEP_LIMIT"
AI_TOOL_CALL_LIMIT = "AI_TOOL_CALL_LIMIT"
AI_CONTEXT_LIMIT = "AI_CONTEXT_LIMIT"
AI_DEADLINE_EXCEEDED = "AI_DEADLINE_EXCEEDED"
AI_CANCELLED = "AI_CANCELLED"
AI_BACKEND_NOT_READY = "AI_BACKEND_NOT_READY"


class ApiError(Exception):
    """An expected, typed error safe to return to a client."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}
        self.headers = headers or {}


class AgentRunError(Exception):
    """A bounded agent failure. ``code`` is stored on the run, not raised to HTTP."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class AgentCancelled(AgentRunError):
    def __init__(self, message: str = "Analysis was cancelled.") -> None:
        super().__init__(AI_CANCELLED, message)
