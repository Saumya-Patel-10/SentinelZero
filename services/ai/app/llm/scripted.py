"""Explicitly simulated model provider for offline demo and deterministic CI.

This class is NEVER selected implicitly. ``AI_PROVIDER_MODE=scripted`` is refused
in production and every run records ``inference_label=SIMULATED_MODEL_OUTPUT``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from app.llm.types import AssistantTurn, ProviderDescriptor, ToolCallRequest

_READ_CALLS = [
    ("call_sim_incident", "get_incident"),
    ("call_sim_assets", "get_assets"),
    ("call_sim_dependencies", "get_dependencies"),
    ("call_sim_tasks", "get_open_tasks"),
    ("call_sim_evidence", "get_evidence_summaries"),
]


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
        if cancel_event is not None and cancel_event.is_set():
            from app.errors import AgentCancelled

            raise AgentCancelled()
        self.calls += 1
        tool_messages = [m for m in messages if m.get("role") == "tool"]
        if not tool_messages:
            return AssistantTurn(
                content=None,
                tool_calls=[
                    ToolCallRequest(id=call_id, name=name, arguments_json="{}")
                    for call_id, name in _READ_CALLS
                ],
                finish_reason="tool_calls",
                usage={"input_tokens": 0, "output_tokens": 0},
                model_identifier=self.descriptor.model_identifier,
                latency_ms=1,
                response_format_used=False,
            )

        evidence: list[dict[str, Any]] = []
        assets_count = 0
        tasks_count = 0
        for message in tool_messages:
            try:
                payload = json.loads(message.get("content") or "{}")
            except (json.JSONDecodeError, TypeError):
                continue
            data = payload.get("data") if isinstance(payload, dict) else None
            name = message.get("name") or payload.get("tool") if isinstance(payload, dict) else None
            if name == "get_evidence_summaries" and isinstance(data, list):
                evidence = [item for item in data if isinstance(item, dict) and item.get("id")]
            elif name == "get_assets" and isinstance(data, list):
                assets_count = len(data)
            elif name == "get_open_tasks" and isinstance(data, list):
                tasks_count = len(data)

        evidence_ids = [str(item["id"]) for item in evidence[:4]]
        facts: list[dict[str, Any]] = []
        if evidence:
            first = evidence[0]
            facts.append(
                {
                    "statement": (
                        f"The incident record contains {len(evidence)} evidence summaries; the first is "
                        f"classified {first.get('classification', 'UNKNOWN')} from "
                        f"{first.get('source', 'an unspecified source')}."
                    ),
                    "evidence_ids": evidence_ids[:1],
                    "confidence": 0.98,
                    "verification_status": "CONFIRMED",
                }
            )
        if assets_count:
            facts.append(
                {
                    "statement": (
                        f"The authorized incident scope contains {assets_count} assets; the recorded "
                        "compromise and availability states remain as shown by the backend and are not "
                        "upgraded by this simulated analysis."
                    ),
                    "evidence_ids": evidence_ids[:1] if evidence_ids else [],
                    "confidence": 0.6,
                    "verification_status": "SUSPECTED",
                }
            )
        # A fact may not cite zero evidence; drop it if no evidence exists.
        facts = [fact for fact in facts if fact["evidence_ids"]]

        task_evidence = evidence_ids[:2]
        recommendation = {
            "summary": (
                "SIMULATED ANALYST OUTPUT. The incident warrants human-led evidence preservation and "
                "continuity review. Exfiltration status must remain explicitly unknown until evidence "
                "supports otherwise. All proposed actions are pending commander approval."
            ),
            "facts": facts,
            "uncertainties": [
                {
                    "question": "Was data exfiltrated before encryption or outage?",
                    "why_unknown": "No tool result in this exercise provides confirmed exfiltration evidence.",
                    "impact_if_true": "Notification, legal, and patient-safety obligations could expand.",
                    "resolution_step": "Have an analyst validate network egress and database access evidence.",
                    "related_evidence_ids": evidence_ids[:2],
                }
            ],
            "proposed_tasks": [
                {
                    "title": "Preserve and hash evidence for the incident",
                    "description": (
                        "Collect and hash the listed evidence sources using the approved forensic process; "
                        "do not delete or modify source systems."
                    ),
                    "priority": "CRITICAL",
                    "rationale": "Evidence must be preserved before recovery changes systems.",
                    "evidence_ids": task_evidence,
                    "evidence_basis": "EVIDENCE_BACKED"
                    if task_evidence
                    else "CONTINUITY_PRACTICE",
                    "risk_level": "LOW",
                    "assigned_role": "ANALYST",
                },
                {
                    "title": "Confirm continuity plan for scheduling downtime",
                    "description": (
                        "Validate manual scheduling and downtime procedures with clinical operations."
                    ),
                    "priority": "HIGH",
                    "rationale": "Scheduling availability may be affected while containment proceeds.",
                    "evidence_ids": [],
                    "evidence_basis": "CONTINUITY_PRACTICE",
                    "risk_level": "LOW",
                    "assigned_role": "RESPONDER",
                },
                {
                    "title": "Keep exfiltration status UNKNOWN pending review",
                    "description": (
                        "Record that exfiltration is not confirmed and assign a human reviewer to update it."
                    ),
                    "priority": "HIGH",
                    "rationale": "Preserve uncertainty rather than inferring data theft.",
                    "evidence_ids": task_evidence,
                    "evidence_basis": "EVIDENCE_BACKED"
                    if task_evidence
                    else "CONTINUITY_PRACTICE",
                    "risk_level": "LOW",
                    "assigned_role": "COMMANDER",
                },
            ],
            "limitations": [
                "SIMULATED_MODEL_OUTPUT: deterministic test double, not live NVIDIA inference.",
                f"Open task count observed: {tasks_count}. Duplicate prevention is human-reviewed.",
            ],
        }
        return AssistantTurn(
            content=json.dumps(recommendation),
            tool_calls=[],
            finish_reason="stop",
            usage={"input_tokens": 0, "output_tokens": 0},
            model_identifier=self.descriptor.model_identifier,
            latency_ms=1,
            response_format_used=response_format is not None,
        )
