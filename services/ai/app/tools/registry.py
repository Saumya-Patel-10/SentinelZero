"""Allowlisted tool execution with strict server-side scoping.

Tool names and argument schemas are fixed. Incident scope comes from the
authenticated server context, never from model-provided arguments. There is no
approval, shell, network, isolation, or deletion tool.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from app.backend import BackendClient
from app.errors import (
    AI_TOOL_ARGUMENTS_INVALID,
    AI_TOOL_EXECUTION_FAILED,
    AI_TOOL_NOT_ALLOWED,
    AgentCancelled,
    AgentRunError,
)
from app.llm.types import ToolCallRequest
from app.schemas import ProposedActionDraft
from app.security.guardrails import (
    ALLOWED_TOOL_NAMES,
    FORBIDDEN_TOOL_NAMES,
    scan_untrusted_text,
)
from app.security.redaction import RedactionStats, redact_structure
from app.tools.specs import TOOL_SPECS

if set(TOOL_SPECS) != set(ALLOWED_TOOL_NAMES):
    raise RuntimeError("Tool registry drifted from the security allowlist.")
if set(TOOL_SPECS) & set(FORBIDDEN_TOOL_NAMES):
    raise RuntimeError("Forbidden tool name present in registry.")


class ToolNotAllowed(AgentRunError):
    def __init__(self, name: str) -> None:
        super().__init__(AI_TOOL_NOT_ALLOWED, f"Tool '{name}' is not allowed.")


class ToolArgumentsInvalid(AgentRunError):
    def __init__(self, message: str = "Tool arguments were invalid.") -> None:
        super().__init__(AI_TOOL_ARGUMENTS_INVALID, message)


class ToolExecutionFailed(AgentRunError):
    def __init__(self, message: str = "A read-only tool failed safely.") -> None:
        super().__init__(AI_TOOL_EXECUTION_FAILED, message)


@dataclass
class ToolContext:
    backend: BackendClient
    incident_id: str
    organization_id: str
    run_id: str
    exercise_label: str
    deadline: float
    cancel_event: asyncio.Event
    max_result_chars: int
    backend_timeout_seconds: float
    proposals: list[ProposedActionDraft] = field(default_factory=list)
    allowed_evidence_ids: set[str] = field(default_factory=set)
    injection_categories: set[str] = field(default_factory=set)
    redaction_counts: dict[str, int] = field(default_factory=dict)
    read_tools_called: set[str] = field(default_factory=set)


@dataclass
class ToolExecution:
    tool_name: str
    payload: dict[str, Any]
    output_summary: dict[str, Any]
    duration_ms: int


ToolHandler = Callable[[ToolContext, dict[str, Any]], Awaitable[tuple[Any, list[str], dict[str, Any]]]]


class ToolRegistry:
    def __init__(self) -> None:
        # Imported here to avoid a circular import at module load.
        from app.tools.incident_tools import HANDLERS as INCIDENT_HANDLERS
        from app.tools.task_tools import HANDLERS as TASK_HANDLERS

        self._handlers: dict[str, ToolHandler] = {**INCIDENT_HANDLERS, **TASK_HANDLERS}
        if set(self._handlers) != set(TOOL_SPECS):
            raise RuntimeError("Tool handlers must exactly match allowlisted tool specs.")
        for name in self._handlers:
            if name in FORBIDDEN_TOOL_NAMES:
                raise RuntimeError(f"Forbidden tool registered: {name}")

    @property
    def tool_names(self) -> tuple[str, ...]:
        return tuple(TOOL_SPECS.keys())

    async def execute(
        self,
        ctx: ToolContext,
        call: ToolCallRequest,
        *,
        allowed: frozenset[str] | None = None,
    ) -> ToolExecution:
        """Execute one allowlisted tool.

        ``allowed`` narrows the global allowlist for a sub-agent; a call outside
        it is denied before any argument parsing or backend access.
        """
        if ctx.cancel_event.is_set():
            raise AgentCancelled()
        if allowed is not None and call.name not in allowed:
            raise ToolNotAllowed(call.name[:60])
        if time.monotonic() >= ctx.deadline:
            raise ToolExecutionFailed("The analysis deadline was exceeded before a tool call.")
        spec = TOOL_SPECS.get(call.name)
        handler = self._handlers.get(call.name)
        if spec is None or handler is None:
            raise ToolNotAllowed(call.name[:60])

        arguments = self._parse_arguments(call, spec.name)
        started = time.monotonic()
        try:
            remaining = max(0.1, min(ctx.backend_timeout_seconds, ctx.deadline - time.monotonic()))
            data, evidence_ids, summary = await asyncio.wait_for(
                handler(ctx, arguments), timeout=remaining
            )
        except asyncio.TimeoutError as exc:
            raise ToolExecutionFailed("A read-only tool timed out.") from exc
        except AgentRunError:
            raise
        except Exception as exc:  # backend/client errors are converted to a safe typed failure
            raise ToolExecutionFailed("A read-only tool failed safely.") from exc

        redacted, redaction = redact_structure(data)
        self._merge_redaction(ctx, redaction)
        encoded = json.dumps(redacted, sort_keys=True, separators=(",", ":"))
        scan = scan_untrusted_text(encoded)
        if scan.suspected:
            ctx.injection_categories.update(scan.categories)
        if len(encoded) > ctx.max_result_chars:
            raise ToolExecutionFailed("A tool result exceeded the configured size bound.")

        if call.name == "get_evidence_summaries" and evidence_ids:
            ctx.allowed_evidence_ids.update(evidence_ids)
        if call.name != "propose_task":
            ctx.read_tools_called.add(call.name)

        payload = {
            "tool": call.name,
            "incident_id": ctx.incident_id,
            "exercise_label": ctx.exercise_label,
            "data": redacted,
            "injection_suspected": scan.suspected,
            "injection_categories": list(scan.categories),
            "redaction_counts": dict(redaction.counts),
        }
        duration_ms = int((time.monotonic() - started) * 1000)
        return ToolExecution(
            tool_name=call.name,
            payload=payload,
            output_summary={
                **summary,
                "injection_suspected": scan.suspected,
                "redactions": sum(redaction.counts.values()),
            },
            duration_ms=duration_ms,
        )

    @staticmethod
    def _parse_arguments(call: ToolCallRequest, name: str) -> dict[str, Any]:
        try:
            parsed = json.loads(call.arguments_json or "{}")
        except json.JSONDecodeError as exc:
            raise ToolArgumentsInvalid("Tool arguments were not valid JSON.") from exc
        if not isinstance(parsed, dict):
            raise ToolArgumentsInvalid("Tool arguments must be a JSON object.")
        if name != "propose_task" and parsed:
            raise ToolArgumentsInvalid(
                "This tool accepts no arguments; incident scope is server-injected."
            )
        return parsed

    @staticmethod
    def _merge_redaction(ctx: ToolContext, stats: RedactionStats) -> None:
        for key, value in stats.counts.items():
            ctx.redaction_counts[key] = ctx.redaction_counts.get(key, 0) + value


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
