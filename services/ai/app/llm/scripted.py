"""Explicitly simulated model provider for offline demo and deterministic CI.

This class is NEVER selected implicitly. ``AI_PROVIDER_MODE=scripted`` is refused
in production and every run records ``inference_label=SIMULATED_MODEL_OUTPUT``.

The provider speaks the orchestrated stage protocol when the offered tools are a
single sub-agent allowlist, and the single-agent ``RecommendationDraft`` schema
when every operational tool is offered together.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from app.llm.types import AssistantTurn, ProviderDescriptor, ToolCallRequest


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
        names = _tool_names(tools)
        tool_messages = [message for message in messages if message.get("role") == "tool"]
        if _is_single_agent(names):
            calls, content = _single_agent_turn(tool_messages)
        else:
            calls, content = _stage_turn(names, tool_messages)
        return AssistantTurn(
            content=content,
            tool_calls=calls,
            finish_reason="tool_calls" if calls else "stop",
            usage={"input_tokens": 0, "output_tokens": 0},
            model_identifier=self.descriptor.model_identifier,
            latency_ms=1,
            response_format_used=response_format is not None and not calls,
        )


def _tool_names(tools: list[dict[str, Any]]) -> set[str]:
    names: set[str] = set()
    for tool in tools or []:
        function = tool.get("function") if isinstance(tool, dict) else None
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.add(function["name"])
    return names


def _is_single_agent(names: set[str]) -> bool:
    return {"get_incident", "get_assets", "propose_task"} <= names


def _call(call_id: str, name: str, arguments: dict[str, Any] | None = None) -> ToolCallRequest:
    return ToolCallRequest(id=call_id, name=name, arguments_json=json.dumps(arguments or {}))


def _payloads(tool_messages: list[dict[str, Any]]) -> list[tuple[str, Any]]:
    found: list[tuple[str, Any]] = []
    for message in tool_messages:
        try:
            payload = json.loads(message.get("content") or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        name = str(message.get("name") or payload.get("tool") or "")
        found.append((name, payload.get("data")))
    return found


def _evidence_ids(tool_messages: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for name, data in _payloads(tool_messages):
        if name != "get_evidence_summaries" or not isinstance(data, list):
            continue
        for item in data:
            if isinstance(item, dict) and item.get("id"):
                ids.append(str(item["id"]))
    return ids


def _assets(tool_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    for name, data in _payloads(tool_messages):
        if name == "get_assets" and isinstance(data, list):
            assets.extend(item for item in data if isinstance(item, dict) and item.get("id"))
    return assets


def _services(tool_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    services: list[dict[str, Any]] = []
    for name, data in _payloads(tool_messages):
        if name == "get_dependencies" and isinstance(data, dict):
            services.extend(
                item for item in data.get("services") or [] if isinstance(item, dict) and item.get("id")
            )
    return services


def _impacts(tool_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    impacts: list[dict[str, Any]] = []
    for name, data in _payloads(tool_messages):
        rows = []
        if name == "get_dependencies" and isinstance(data, dict):
            rows = data.get("operational_impacts") or data.get("impacts") or []
        impacts.extend(item for item in rows if isinstance(item, dict))
    return impacts


def _uncertainty(evidence_ids: list[str]) -> dict[str, Any]:
    return {
        "question": "Was data exfiltrated?",
        "why_unknown": "No tool result in this exercise provides confirmed exfiltration evidence.",
        "impact_if_true": "Notification, legal, and continuity obligations could expand.",
        "resolution_step": "Have an analyst validate network egress and database access evidence.",
        "related_evidence_ids": evidence_ids[:1],
    }


def _triage_json(evidence_ids: list[str]) -> str:
    facts = []
    if evidence_ids:
        facts.append(
            {
                "statement": "The backend returned evidence metadata for this incident. Compromise status is not upgraded by this simulated analysis.",
                "evidence_ids": evidence_ids[:1],
                "verification": "SUSPECTED",
                "confidence": 0.6,
            }
        )
    return json.dumps(
        {
            "headline": "Suspected ransomware; exfiltration remains UNKNOWN.",
            "summary": "SIMULATED triage. Evidence metadata was read. Exfiltration stays UNKNOWN until a human confirms it.",
            "priority": "P1",
            "facts": facts,
            "uncertainties": [_uncertainty(evidence_ids)],
        }
    )


def _impact_json(tool_messages: list[dict[str, Any]], evidence_ids: list[str]) -> str:
    services = _services(tool_messages)
    impacts = _impacts(tool_messages)
    mappings = []
    for asset in _assets(tool_messages)[:5]:
        service_id = str(services[0]["id"]) if services else None
        human_unit = "Incident command"
        if impacts and impacts[0].get("affected_group"):
            human_unit = str(impacts[0]["affected_group"])[:160]
        mappings.append(
            {
                "asset_id": str(asset["id"]),
                "service_id": service_id,
                "human_unit": human_unit,
                "compromise": str(asset.get("compromise_status") or "UNKNOWN"),
                "exfiltration": "UNKNOWN",
                "evidence_ids": evidence_ids[:1],
            }
        )
    return json.dumps(
        {
            "summary": "SIMULATED impact. Asset status is copied from the backend. Exfiltration remains UNKNOWN.",
            "mappings": mappings,
            "uncertainties": [_uncertainty(evidence_ids)] if evidence_ids else [],
        }
    )


def _proposal(evidence_ids: list[str]) -> dict[str, Any]:
    return {
        "title": "Preserve evidence before recovery",
        "description": "Preserve and hash the listed evidence using the approved forensic process. Do not delete or modify source systems.",
        "priority": "P1",
        "rationale": "Evidence must be preserved before recovery changes systems.",
        "evidence_ids": evidence_ids[:1],
        "uncertainties": ["Was data exfiltrated?"],
    }


def _containment_json() -> str:
    return json.dumps(
        {
            "summary": "SIMULATED containment. The preservation proposal is PENDING and is not approved or executed.",
            "rationale": "Preserve evidence first, then verify exfiltration before any recovery step.",
        }
    )


def _communications_json(evidence_ids: list[str]) -> str:
    cited = evidence_ids[0] if evidence_ids else "none yet"
    return json.dumps(
        {
            "audience": "INCIDENT_COMMAND",
            "sitrep": (
                f"SIMULATED sitrep for commander review only. This message has not been sent. "
                f"Evidence considered: {cited}. Exfiltration status remains UNKNOWN. "
                "The preservation action is pending human approval."
            ),
        }
    )


def _recommendation_json(evidence_ids: list[str]) -> str:
    facts = []
    if evidence_ids:
        facts.append(
            {
                "statement": "The backend returned evidence metadata for this incident. This simulated analysis does not upgrade that status.",
                "evidence_ids": evidence_ids[:1],
                "verification": "SUSPECTED",
                "confidence": 0.6,
            }
        )
    return json.dumps(
        {
            "title": "Suspected ransomware; exfiltration remains UNKNOWN.",
            "description": "SIMULATED single-agent recommendation. All proposed actions remain pending commander approval.",
            "priority": "P1",
            "rationale": "Preserve evidence and keep exfiltration UNKNOWN until a human reviews it.",
            "facts": facts,
            "uncertainties": [_uncertainty(evidence_ids)],
            "proposed_actions": [_proposal(evidence_ids)],
            "limitations": ["SIMULATED_MODEL_OUTPUT: deterministic test double, not live NVIDIA inference."],
        }
    )


def _single_agent_turn(tool_messages: list[dict[str, Any]]) -> tuple[list[ToolCallRequest], str | None]:
    if not tool_messages:
        return (
            [
                _call("call_sim_incident", "get_incident"),
                _call("call_sim_assets", "get_assets"),
                _call("call_sim_dependencies", "get_dependencies"),
                _call("call_sim_tasks", "get_open_tasks"),
                _call("call_sim_evidence", "get_evidence_summaries"),
            ],
            None,
        )
    return [], _recommendation_json(_evidence_ids(tool_messages))


def _stage_turn(
    names: set[str], tool_messages: list[dict[str, Any]]
) -> tuple[list[ToolCallRequest], str | None]:
    called = {name for name, _ in _payloads(tool_messages)}
    evidence_ids = _evidence_ids(tool_messages)
    if not names:
        return [], _communications_json(evidence_ids)
    if "get_incident" in names and "get_incident" not in called:
        calls = [_call("call_sim_incident", "get_incident")]
        if "get_evidence_summaries" in names:
            calls.append(_call("call_sim_evidence", "get_evidence_summaries"))
        return calls, None
    if "get_incident" in names:
        return [], _triage_json(evidence_ids)
    if "get_assets" in names and "get_assets" not in called:
        calls = [_call("call_sim_assets", "get_assets")]
        if "get_dependencies" in names:
            calls.append(_call("call_sim_dependencies", "get_dependencies"))
        return calls, None
    if "get_assets" in names:
        return [], _impact_json(tool_messages, evidence_ids)
    if "propose_task" in names and "get_open_tasks" in names and "get_open_tasks" not in called:
        return [_call("call_sim_tasks", "get_open_tasks")], None
    if "propose_task" in names and "propose_task" not in called:
        return [_call("call_sim_propose", "propose_task", _proposal(evidence_ids))], None
    if "propose_task" in names:
        return [], _containment_json()
    return [], _communications_json(evidence_ids)
