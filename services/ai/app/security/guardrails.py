"""Prompt-injection detection and output text hygiene.

Untrusted incident data is never treated as instructions. Detection is advisory
for the model prompt and for audit; the hard security boundary is that no
privileged tool exists and every tool is incident-scoped server-side.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Deliberately conservative; matched text is not stored or logged.
_INJECTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("instruction_override", re.compile(r"(?i)\b(ignore|disregard|forget)\b.{0,40}\b(previous|above|prior|system)\b.{0,40}\b(instructions?|prompt|rules?)\b")),
    ("role_override", re.compile(r"(?i)\b(you are now|act as|new system prompt|developer message|system prompt)\b")),
    ("secret_exfiltration", re.compile(r"(?i)\b(reveal|print|show|leak|exfiltrate)\b.{0,40}\b(api[ _-]?key|token|secret|password|credential)s?\b")),
    ("destructive_command", re.compile(r"(?i)\b(rm\s+-rf|del\s+/[fsq]|format\s+[a-z]:|powershell|cmd\.exe|bash\s+-c|shutdown\s+/[sr]|drop\s+table|truncate\s+table)\b")),
    ("approval_bypass", re.compile(r"(?i)\b(approve|self[- ]approve|mark (this|the) task (as )?approved|bypass|skip)\b.{0,40}\b(approval|commander|human)\b")),
    ("tool_injection", re.compile(r"(?i)\b(tool_calls?|function_call|call the tool|invoke)\b.{0,40}\b(propose_task|approve_task|delete|isolate|disable)\b")),
    ("external_contact", re.compile(r"(?i)\b(send|email|post|upload|contact)\b.{0,40}\b(attacker|external|webhook|pastebin|telegram|http[s]?://)\b")),
)

_UNSAFE_MARKUP = re.compile(
    r"(?i)(<\s*script\b|<\s*iframe\b|<\s*object\b|<\s*embed\b|javascript\s*:|vbscript\s*:|data\s*:\s*text/html|on[a-z]+\s*=\s*[\"'])"
)
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")


class UnsafeTextError(ValueError):
    """Raised when generated text contains unsafe markup or control characters."""


@dataclass(frozen=True)
class InjectionScan:
    suspected: bool
    categories: tuple[str, ...] = ()
    risk: str = "LOW"
    char_count: int = 0

    def label(self) -> str:
        if not self.suspected:
            return "NO_INDICATORS"
        return "SUSPECTED_PROMPT_INJECTION:" + ",".join(self.categories)


@dataclass(frozen=True)
class RedactionStats:
    counts: dict[str, int] = field(default_factory=dict)
    truncated_fields: int = 0

    @property
    def total(self) -> int:
        return sum(self.counts.values())


def scan_untrusted_text(text: str | None) -> InjectionScan:
    if not text:
        return InjectionScan(suspected=False, char_count=0)
    categories: list[str] = []
    for category, pattern in _INJECTION_PATTERNS:
        if pattern.search(text):
            categories.append(category)
    suspected = bool(categories)
    high_risk = any(
        c in {"destructive_command", "approval_bypass", "secret_exfiltration", "tool_injection"}
        for c in categories
    )
    return InjectionScan(
        suspected=suspected,
        categories=tuple(sorted(set(categories))),
        risk="HIGH" if high_risk else ("MEDIUM" if suspected else "LOW"),
        char_count=len(text),
    )


def clean_text(value: str, *, field_name: str, max_length: int) -> str:
    """Normalize model/backend text and reject active markup.

    The web client must still render text as text; this is defense in depth.
    """

    if not isinstance(value, str):
        raise UnsafeTextError(f"{field_name} must be a string")
    normalized = _ZERO_WIDTH.sub("", value)
    normalized = _CONTROL_CHARS.sub("", normalized).strip()
    if len(normalized) > max_length:
        raise UnsafeTextError(f"{field_name} exceeds {max_length} characters")
    if _UNSAFE_MARKUP.search(normalized):
        raise UnsafeTextError(f"{field_name} contains unsafe markup")
    return normalized


def inspect_untrusted(value: str, *, max_length: int = 4_000) -> tuple[str, InjectionScan]:
    """Trim untrusted data for inclusion in a prompt without deleting evidence text."""

    text = (value or "")[:max_length]
    text = _CONTROL_CHARS.sub("", text)
    return text, scan_untrusted_text(text)


def contains_unsafe_markup(value: str) -> bool:
    return bool(_UNSAFE_MARKUP.search(value))


# Exact allowlist of operational tools. Anything else is unreachable by design.
ALLOWED_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "get_incident",
        "get_assets",
        "get_dependencies",
        "get_open_tasks",
        "get_evidence_summaries",
        "propose_task",
    }
)

# Names that must never be registered, even if a future change attempts it.
FORBIDDEN_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "approve_task",
        "reject_task",
        "execute_shell",
        "run_command",
        "delete_evidence",
        "isolate_endpoint",
        "disable_account",
        "change_firewall",
        "contact_external_service",
        "transition_incident_status",
        "mark_resolved",
        "submit_recommendation",
    }
)
