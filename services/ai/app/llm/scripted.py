"""Explicitly simulated model provider for offline demo and deterministic CI.

This class is NEVER selected implicitly. ``AI_PROVIDER_MODE=scripted`` is refused
in production and every run records ``inference_label=SIMULATED_MODEL_OUTPUT``.

It drives both agent modes:

* ``AI_AGENT_MODE=single``: one read round (the five read tools) then one
  schema-valid recommendation.
* ``AI_AGENT_MODE=orchestrated``: each sub-agent prompt is marked
  ``[sentinelzero-subagent:triage|impact|containment|communications]``. The
  provider calls only the tools offered to that step, then returns that
  step's schema. Status values are copied from tool results and never upgraded.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from app.agents.subagents import (
    CommunicationsOutput,
    ContainmentOutput,
    ImpactMapping,
    ImpactOutput,
    TriageOutput,
)
from app.llm.types import AssistantTurn, ProviderDescriptor, ToolCallRequest
from app.schemas import FactDraft, ProposedActionDraft, RecommendationDraft, UncertaintyDraft

_READ_CALLS = [
    ("call_sim_incident", "get_incident"),
    ("call_sim_assets", "get_assets"),
    ("call_sim_dependencies", "get_dependencies"),
    ("call_sim_tasks", "get_open_tasks"),
    ("call_sim_evidence", "get_evidence_summaries"),
]

_SUBAGENT_MARK = re.compile(
    r"\[sentinelzero-subagent:(triage|impact|containment|communications)\]"
)
_EVIDENCE_LINE = re.compile(
    r"AUTHORIZED EVIDENCE IDS \(returned by the backend so far\): ([^\n\r]+)"
)
_EVIDENCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
_VERIFICATION = {"UNKNOWN", "SUSPECTED", "CONFIRMED", "RULED_OUT"}
_EXFIL_RANK = {"CONFIRMED": 3, "SUSPECTED": 2, "UNKNOWN": 1, "RULED_OUT": 0}


def _subagent_name(messages: list[dict[str, Any]]) -> str | None:
    for message in messages:
        if message.get("role") != "system":
            continue
        match = _SUBAGENT_MARK.search(message.get("content") or "")
        if match:
            return match.group(1)
    return None


def _offered_tools(tools: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for tool in tools or []:
        function = tool.get("function") if isinstance(tool, dict) else None
        name = (function or {}).get("name") if isinstance(function, dict) else None
        if isinstance(name, str):
            names.append(name)
    return names


def _tool_payloads(messages: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    for message in messages:
        if message.get("role") != "tool":
            continue
        try:
            payload = json.loads(message.get("content") or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        name = message.get("name") or payload.get("tool")
        if isinstance(name, str):
            found.append((name, payload))
    return found


def _safe_ids(ids: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for item in ids:
        if item in seen or not _EVIDENCE_ID.fullmatch(item):
            continue
        seen.add(item)
        unique.append(item)
    return unique[:20]


def _authorized_ids(messages: list[dict[str, Any]]) -> list[str]:
    found: list[str] = []
    for message in messages:
        content = message.get("content")
        if not isinstance(content, str):
            continue
        match = _EVIDENCE_LINE.search(content)
        if not match:
            continue
        raw = match.group(1).strip()
        if raw.startswith("("):
            continue
        found.extend(part.strip() for part in raw.split(",") if part.strip())
    for name, payload in _tool_payloads(messages):
        data = payload.get("data")
        if name == "get_evidence_summaries" and isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and item.get("id"):
                    found.append(str(item["id"]))
    return _safe_ids(found)


def _uncertainty(evidence_ids: list[str]) -> UncertaintyDraft:
    return UncertaintyDraft(
        question="Was data exfiltrated?",
        why_unknown="No tool result in this exercise shows that data left the environment.",
        impact_if_true="Notification, legal, and patient-safety obligations could expand.",
        resolution_step="Have an analyst validate network egress and database access evidence.",
        related_evidence_ids=evidence_ids[:2],
    )


def _proposal(evidence_ids: list[str]) -> ProposedActionDraft:
    return ProposedActionDraft(
        title="Preserve and hash evidence for the incident",
        description=(
            "Collect and hash the listed evidence using the approved forensic process. "
            "Do not delete or modify source systems."
        ),
        priority="P1",
        rationale="Evidence must be preserved before recovery changes systems.",
        evidence_ids=evidence_ids[:2],
    )


class ScriptedNemotronProvider:
    descriptor = ProviderDescriptor(
        mode="scripted",
        endpoint_class="SIMULATED_SCRIPTED",
        model_identifier="scripted-local-test-model",
        inference_label="SIMULATED_MODEL_OUTPUT",
        configured=True,
    )

    def __init__(self) -> None:
        self.calls = 0

    async def aclose(self) -> None:
        return None

    async def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
        deadline: float,
        cancel_event: asyncio.Event | None,
    ) -> AssistantTurn:
        del deadline
        if cancel_event is not None and cancel_event.is_set():
            from app.errors import AgentCancelled

            raise AgentCancelled()
        self.calls += 1
        name = _subagent_name(messages)
        if name is not None:
            return self._subagent_turn(name, messages, tools, response_format)
        return self._single_turn(messages, response_format)

    def _subagent_turn(
        self,
        name: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
    ) -> AssistantTurn:
        answered = {tool_name for tool_name, _payload in _tool_payloads(messages)}
        pending = [tool_name for tool_name in _offered_tools(tools) if tool_name not in answered]
        if pending:
            evidence_ids = _authorized_ids(messages)
            calls = []
            for tool_name in pending:
                arguments = "{}"
                if tool_name == "propose_task":
                    arguments = json.dumps(_proposal(evidence_ids).model_dump(mode="json"))
                calls.append(
                    ToolCallRequest(
                        id=f"call_{name}_{tool_name}",
                        name=tool_name,
                        arguments_json=arguments,
                    )
                )
            return self._turn(content=None, tool_calls=calls, finish_reason="tool_calls", response_format=None)
        return self._turn(
            content=json.dumps(self._subagent_json(name, messages)),
            tool_calls=[],
            finish_reason="stop",
            response_format=response_format,
        )

    def _single_turn(
        self,
        messages: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
    ) -> AssistantTurn:
        if not _tool_payloads(messages):
            return self._turn(
                content=None,
                tool_calls=[
                    ToolCallRequest(id=call_id, name=name, arguments_json="{}")
                    for call_id, name in _READ_CALLS
                ],
                finish_reason="tool_calls",
                response_format=None,
            )
        return self._turn(
            content=json.dumps(self._single_json(messages)),
            tool_calls=[],
            finish_reason="stop",
            response_format=response_format,
        )

    def _turn(
        self,
        *,
        content: str | None,
        tool_calls: list[ToolCallRequest],
        finish_reason: str,
        response_format: dict[str, Any] | None,
    ) -> AssistantTurn:
        return AssistantTurn(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            usage={"input_tokens": 0, "output_tokens": 0},
            model_identifier=self.descriptor.model_identifier,
            latency_ms=1,
            response_format_used=response_format is not None,
        )

    def _subagent_json(self, name: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
        evidence_ids = _authorized_ids(messages)
        if name == "triage":
            return self._triage_json(messages, evidence_ids)
        if name == "impact":
            return self._impact_json(messages, evidence_ids)
        if name == "containment":
            return ContainmentOutput(
                summary=(
                    "SIMULATED containment and recovery plan. Proposed actions stay pending "
                    "human approval and nothing was executed."
                ),
                rationale="Preserve evidence and continuity first. A human commander must approve every action.",
            ).model_dump(mode="json")
        return CommunicationsOutput(
            audience="INCIDENT_COMMAND",
            sitrep=(
                "SIMULATED situation report for the incident commander. "
                "Known: exercise evidence is on file and asset status is only what the backend reported. "
                "Unknown: whether any data was exfiltrated. "
                "Pending: containment proposals await human approval and have not been sent or executed. "
                "Next update: after the commander reviews this draft."
            ),
        ).model_dump(mode="json")

    def _triage_json(self, messages: list[dict[str, Any]], evidence_ids: list[str]) -> dict[str, Any]:
        facts: list[FactDraft] = []
        for _name, payload in _tool_payloads(messages):
            data = payload.get("data")
            if _name != "get_evidence_summaries" or not isinstance(data, list) or not data:
                continue
            first = data[0] if isinstance(data[0], dict) else {}
            if not evidence_ids:
                break
            facts.append(
                FactDraft(
                    statement=(
                        f"SIMULATED. The incident record contains {len(data)} evidence summaries; "
                        f"the first is classified {first.get('classification', 'UNKNOWN')} from "
                        f"{first.get('source', 'an unspecified source')}."
                    ),
                    evidence_ids=evidence_ids[:1],
                    verification="CONFIRMED",
                    confidence=0.98,
                )
            )
            break
        return TriageOutput(
            headline="SIMULATED triage: suspected ransomware; exfiltration UNKNOWN",
            summary=(
                "SIMULATED triage. Retrieved evidence stays cited and exfiltration stays UNKNOWN "
                "until a human analyst reviews it. All later actions require approval."
            ),
            priority="P1",
            facts=facts,
            uncertainties=[_uncertainty(evidence_ids)],
        ).model_dump(mode="json")

    def _impact_json(self, messages: list[dict[str, Any]], evidence_ids: list[str]) -> dict[str, Any]:
        assets: list[dict[str, Any]] = []
        services: list[dict[str, Any]] = []
        for name, payload in _tool_payloads(messages):
            data = payload.get("data")
            if name == "get_assets" and isinstance(data, list):
                assets = [item for item in data if isinstance(item, dict)]
            elif name == "get_dependencies" and isinstance(data, dict):
                services = [item for item in data.get("services") or [] if isinstance(item, dict)]
        service_id = None
        if services and isinstance(services[0].get("id"), str) and _EVIDENCE_ID.fullmatch(str(services[0]["id"])):
            service_id = str(services[0]["id"])
        mappings: list[ImpactMapping] = []
        for asset in assets[:30]:
            asset_id = str(asset.get("id") or "")
            compromise = str(asset.get("compromise_status") or "UNKNOWN")
            if not _EVIDENCE_ID.fullmatch(asset_id) or compromise not in _VERIFICATION:
                continue
            scopes = asset.get("data_scopes") or []
            statuses = [
                str(scope.get("exfiltration_status") or "UNKNOWN")
                for scope in scopes
                if isinstance(scope, dict)
            ] or ["UNKNOWN"]
            exfiltration = max(statuses, key=lambda item: _EXFIL_RANK.get(item, 1))
            if exfiltration not in _VERIFICATION:
                exfiltration = "UNKNOWN"
            mappings.append(
                ImpactMapping(
                    asset_id=asset_id,
                    service_id=service_id,
                    human_unit="Clinical operations team",
                    compromise=compromise,  # type: ignore[arg-type]
                    exfiltration=exfiltration,  # type: ignore[arg-type]
                    evidence_ids=evidence_ids[:1],
                )
            )
        return ImpactOutput(
            summary=(
                "SIMULATED impact. Each backend asset keeps the compromise and exfiltration "
                "status the backend reported. Nothing was upgraded."
            ),
            mappings=mappings,
            uncertainties=[_uncertainty(evidence_ids)],
        ).model_dump(mode="json")

    def _single_json(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        evidence: list[dict[str, Any]] = []
        assets_count = 0
        tasks_count = 0
        for name, payload in _tool_payloads(messages):
            data = payload.get("data")
            if name == "get_evidence_summaries" and isinstance(data, list):
                evidence = [item for item in data if isinstance(item, dict) and item.get("id")]
            elif name == "get_assets" and isinstance(data, list):
                assets_count = len(data)
            elif name == "get_open_tasks" and isinstance(data, list):
                tasks_count = len(data)
        evidence_ids = _safe_ids([str(item["id"]) for item in evidence[:4]])
        facts: list[FactDraft] = []
        if evidence and evidence_ids:
            first = evidence[0]
            facts.append(
                FactDraft(
                    statement=(
                        f"SIMULATED. The incident record contains {len(evidence)} evidence summaries; "
                        f"the first is classified {first.get('classification', 'UNKNOWN')} from "
                        f"{first.get('source', 'an unspecified source')}."
                    ),
                    evidence_ids=evidence_ids[:1],
                    verification="CONFIRMED",
                    confidence=0.98,
                )
            )
        if assets_count and evidence_ids:
            facts.append(
                FactDraft(
                    statement=(
                        f"SIMULATED. The authorized incident scope contains {assets_count} assets. "
                        "Recorded compromise and availability stay as the backend showed them."
                    ),
                    evidence_ids=evidence_ids[:1],
                    verification="SUSPECTED",
                    confidence=0.6,
                )
            )
        draft = RecommendationDraft(
            title="SIMULATED: suspected ransomware; exfiltration remains UNKNOWN.",
            description=(
                "SIMULATED ANALYST OUTPUT. The incident warrants human-led evidence preservation and "
                "continuity review. Exfiltration status must remain explicitly unknown until evidence "
                "supports otherwise. All proposed actions are pending commander approval. "
                f"Open task count observed: {tasks_count}."
            ),
            priority="P1",
            rationale="Preserve evidence and keep exfiltration status UNKNOWN pending human review.",
            facts=facts,
            uncertainties=[_uncertainty(evidence_ids)],
            proposed_actions=[
                _proposal(evidence_ids),
                ProposedActionDraft(
                    title="Confirm continuity plan for scheduling downtime",
                    description="Validate manual scheduling and downtime procedures with clinical operations.",
                    priority="P2",
                    rationale="Scheduling availability may be affected while containment proceeds.",
                    evidence_ids=[],
                ),
            ],
            limitations=[
                "SIMULATED_MODEL_OUTPUT: deterministic test double, not live NVIDIA inference.",
            ],
        )
        return draft.model_dump(mode="json")
