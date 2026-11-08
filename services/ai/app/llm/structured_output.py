"""Structured output extraction and strict evidence validation."""

from __future__ import annotations

import json
import re

from app.errors import AI_OUTPUT_INVALID, AgentRunError
from app.schemas import ProposedActionDraft, RecommendationDraft

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL | re.IGNORECASE)
_MAX_OUTPUT_CHARS = 100_000


class OutputValidationError(AgentRunError):
    def __init__(self, message: str, *, code: str = AI_OUTPUT_INVALID) -> None:
        super().__init__(code, message)


def extract_json_object(content: str | None, *, max_chars: int = _MAX_OUTPUT_CHARS) -> dict:
    if not content or not content.strip():
        raise OutputValidationError("Model returned no final JSON content.")
    if len(content) > max_chars:
        raise OutputValidationError("Model output exceeded the allowed size.")
    text = content.strip()
    fence = _FENCE.match(text)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise OutputValidationError("Model output did not contain a JSON object.")
    candidate = text[start : end + 1]
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise OutputValidationError("Model output was not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise OutputValidationError("Model output must be a JSON object.")
    return parsed


def validate_against_evidence(
    draft: RecommendationDraft,
    *,
    allowed_evidence_ids: set[str],
) -> RecommendationDraft:
    """Reject fabricated evidence references and unsupported task claims."""

    allowed = {eid for eid in allowed_evidence_ids if eid}

    for fact in draft.facts:
        unknown = [eid for eid in fact.evidence_ids if eid not in allowed]
        if unknown:
            raise OutputValidationError(
                "A proposed fact cited evidence ids that were not returned by tools."
            )

    for uncertainty in draft.uncertainties:
        unknown = [eid for eid in uncertainty.related_evidence_ids if eid not in allowed]
        if unknown:
            raise OutputValidationError(
                "An uncertainty cited evidence ids that were not returned by tools."
            )

    seen_titles: set[str] = set()
    normalized_actions: list[ProposedActionDraft] = []
    for action in draft.proposed_actions:
        unknown = [eid for eid in action.evidence_ids if eid not in allowed]
        if unknown:
            raise OutputValidationError(
                "A proposed action cited evidence ids that were not returned by tools."
            )
        key = action.title.casefold()
        if key in seen_titles:
            continue
        seen_titles.add(key)
        normalized_actions.append(action)

    return draft.model_copy(update={"proposed_actions": normalized_actions[:MAX_PROPOSED_ACTIONS]})


MAX_PROPOSED_ACTIONS = 5


def merge_tool_proposals(
    draft: RecommendationDraft,
    tool_proposals: list[ProposedActionDraft],
) -> RecommendationDraft:
    """Include validated pending proposals recorded through ``propose_task``.

    Final-message actions remain authoritative; duplicates are collapsed by title.
    Tool proposals are never submitted or approved here.
    """

    merged: list[ProposedActionDraft] = []
    seen: set[str] = set()
    for action in [*draft.proposed_actions, *tool_proposals]:
        key = action.title.casefold()
        if key in seen:
            continue
        seen.add(key)
        merged.append(action)
    if len(merged) > MAX_PROPOSED_ACTIONS:
        raise OutputValidationError("More than five proposed actions were produced.")
    return draft.model_copy(update={"proposed_actions": merged})


def evidence_ids_used(draft: RecommendationDraft) -> list[str]:
    ids: list[str] = []
    for fact in draft.facts:
        ids.extend(fact.evidence_ids)
    for uncertainty in draft.uncertainties:
        ids.extend(uncertainty.related_evidence_ids)
    for action in draft.proposed_actions:
        ids.extend(action.evidence_ids)
    return sorted({eid for eid in ids})
