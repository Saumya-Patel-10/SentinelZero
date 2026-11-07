"""Provider-neutral inference types."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class ToolCallRequest:
    id: str
    name: str
    arguments_json: str


@dataclass
class AssistantTurn:
    content: str | None
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, int] = field(default_factory=dict)
    model_identifier: str | None = None
    provider_request_id: str | None = None
    latency_ms: int = 0
    response_format_used: bool = False


@dataclass(frozen=True)
class ProviderDescriptor:
    mode: str
    endpoint_class: str
    model_identifier: str
    inference_label: str
    configured: bool


class ModelProvider(Protocol):
    descriptor: ProviderDescriptor

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
        deadline: float,
        cancel_event: asyncio.Event | None,
    ) -> AssistantTurn: ...

    async def aclose(self) -> None: ...


class ProviderError(Exception):
    """Typed provider failure with a safe category."""

    category = "AI_PROVIDER_UNAVAILABLE"
    retryable = False

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class ProviderNotConfigured(ProviderError):
    category = "AI_PROVIDER_NOT_CONFIGURED"


class ProviderAuthError(ProviderError):
    category = "AI_PROVIDER_AUTH_FAILED"


class ProviderTimeout(ProviderError):
    category = "AI_PROVIDER_TIMEOUT"
    retryable = True


class ProviderRateLimited(ProviderError):
    category = "AI_PROVIDER_RATE_LIMITED"
    retryable = True

    def __init__(self, message: str, *, retry_after: int = 5) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ProviderUnavailable(ProviderError):
    category = "AI_PROVIDER_UNAVAILABLE"
    retryable = True


class ProviderProtocolError(ProviderError):
    category = "AI_PROVIDER_PROTOCOL_ERROR"


class ProviderRequestRejected(ProviderError):
    category = "AI_PROVIDER_PROTOCOL_ERROR"
