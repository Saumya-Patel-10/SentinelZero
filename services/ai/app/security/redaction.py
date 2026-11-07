"""Data minimization and deterministic redaction before provider egress."""

from __future__ import annotations

import re
from typing import Any

from app.security.guardrails import RedactionStats

_patterns: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("email", re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")),
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("mrn", re.compile(r"(?i)\bMRN[:\s#-]*\d{5,12}\b")),
    ("phone", re.compile(r"(?<!\d)(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)")),
    ("date_of_birth", re.compile(r"(?i)\bDOB[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b")),
    ("api_token", re.compile(r"(?i)\b(?:nvapi-|sk-)[A-Za-z0-9._-]{12,}\b")),
    ("bearer", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}")),
)

_REPLACEMENTS = {
    "email": "[EMAIL_REDACTED]",
    "ssn": "[SSN_REDACTED]",
    "mrn": "[MRN_REDACTED]",
    "phone": "[PHONE_REDACTED]",
    "date_of_birth": "[DOB_REDACTED]",
    "api_token": "[TOKEN_REDACTED]",
    "bearer": "[TOKEN_REDACTED]",
}

_MAX_STRING = 2_000
_MAX_ITEMS = 100
_MAX_DEPTH = 6


def redact_text(value: str) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}
    text = value[:_MAX_STRING]
    for name, pattern in _patterns:
        text, n = pattern.subn(_REPLACEMENTS[name], text)
        if n:
            counts[name] = counts.get(name, 0) + n
    return text, counts


def redact_structure(value: Any, *, _depth: int = 0) -> tuple[Any, RedactionStats]:
    """Recursively redact and bound provider-bound context.

    Lists are capped at 100 items and strings at 2,000 chars. Callers still
    enforce domain-specific limits; this is a final minimization boundary.
    """

    counts: dict[str, int] = {}
    truncated = 0
    if _depth > _MAX_DEPTH:
        return "[TRUNCATED_DEPTH]", RedactionStats(counts, truncated + 1)
    if isinstance(value, str):
        text, found = redact_text(value)
        if len(value) > _MAX_STRING:
            truncated += 1
        for k, v in found.items():
            counts[k] = counts.get(k, 0) + v
        return text, RedactionStats(counts, truncated)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_ITEMS:
                truncated += 1
                break
            safe_key = str(key)[:80]
            safe_value, stats = redact_structure(item, _depth=_depth + 1)
            out[safe_key] = safe_value
            for k, v in stats.counts.items():
                counts[k] = counts.get(k, 0) + v
            truncated += stats.truncated_fields
        return out, RedactionStats(counts, truncated)
    if isinstance(value, (list, tuple)):
        out_list: list[Any] = []
        for index, item in enumerate(value):
            if index >= _MAX_ITEMS:
                truncated += 1
                break
            safe_item, stats = redact_structure(item, _depth=_depth + 1)
            out_list.append(safe_item)
            for k, v in stats.counts.items():
                counts[k] = counts.get(k, 0) + v
            truncated += stats.truncated_fields
        return out_list, RedactionStats(counts, truncated)
    return value, RedactionStats(counts, truncated)


def merge_stats(stats: list[RedactionStats]) -> RedactionStats:
    counts: dict[str, int] = {}
    truncated = 0
    for stat in stats:
        truncated += stat.truncated_fields
        for key, value in stat.counts.items():
            counts[key] = counts.get(key, 0) + value
    return RedactionStats(counts, truncated)
