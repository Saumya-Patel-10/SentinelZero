"""Pydantic contracts for the FastAPI browser-facing API and internal run records.

The browser-facing contract is frozen in packages/shared/src/schemas.ts:
AiAnalyzeRequest {incident_id, run_id, analysis_type} and
AiAnalyzeResponse {run_id, status, inference_mode, model_identifier,
verified_facts, uncertainties, proposed_actions, error_category}.

Internal run records mirror the SpacetimeDB agent_run / agent_tool_call /
recommendation tables (inference_mode = LIVE | SIMULATED | FIXTURE).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.security.guardrails import clean_text

Role = Literal["OWNER", "COMMANDER", "ANALYST", "RESPONDER", "OBSERVER"]
RunStatus = Literal["REQUESTED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]
InferenceMode = Literal["LIVE", "SIMULATED", "FIXTURE"]
TaskPriority = Literal["P1", "P2", "P3", "P4"]
Verification = Literal["UNKNOWN", "SUSPECTED", "CONFIRMED", "RULED_OUT"]
RecommendationStatus = Literal["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]
AnalysisType = Literal["intake", "impact", "response"]

EvidenceId = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")]
ShortText = Annotated[str, Field(min_length=1, max_length=160)]
MediumText = Annotated[str, Field(min_length=1, max_length=600)]
LongText = Annotated[str, Field(min_length=1, max_length=1_500)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _clean(value: str, *, field: str, limit: int) -> str:
    try:
        return clean_text(value, field_name=field, max_length=limit)
    except ValueError as exc:  # surface as a normal validation error
        raise ValueError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Browser-facing request (matches AiAnalyzeRequest in packages/shared/src/schemas.ts)
# ---------------------------------------------------------------------------


class AnalysisRequest(_StrictModel):
    incident_id: Annotated[str, Field(min_length=1, max_length=64)]
    run_id: Annotated[str, Field(min_length=1, max_length=64)]
    analysis_type: AnalysisType

    @field_validator("incident_id", "run_id")
    @classmethod
    def _ids(cls, value: str) -> str:
        return _clean(value, field="id", limit=64)


# ---------------------------------------------------------------------------
# Browser-facing response (matches AiAnalyzeResponse subset returned at 202)
# ---------------------------------------------------------------------------


class AnalysisAccepted(_StrictModel):
    run_id: Annotated[str, Field(min_length=1, max_length=64)]
    status: RunStatus = "RUNNING"
    inference_mode: InferenceMode
    model_identifier: Annotated[str, Field(max_length=200)]
    error_category: Annotated[str | None, Field(max_length=60)] = None


# ---------------------------------------------------------------------------
# Internal run records (mirror SpacetimeDB tables)
# ---------------------------------------------------------------------------


class ToolCallRecord(_StrictModel):
    id: ShortText
    tool_name: Annotated[str, Field(max_length=60)]
    input_summary: dict[str, object] = Field(default_factory=dict)
    output_summary: dict[str, object] = Field(default_factory=dict)
    # DENIED = the tool was outside the (sub-)agent allowlist and never executed.
    status: Literal["OK", "ERROR", "DENIED"] = "OK"
    timestamp: datetime
    duration_ms: int = Field(ge=0)
    subagent: Annotated[str | None, Field(max_length=40)] = None


class ProviderCallRecord(_StrictModel):
    step: int = Field(ge=1)
    model_identifier: Annotated[str, Field(max_length=120)]
    endpoint_class: Annotated[str, Field(max_length=60)]
    status: Literal["OK", "ERROR"]
    latency_ms: int = Field(ge=0)
    finish_reason: Annotated[str | None, Field(max_length=40)] = None
    tool_calls: int = Field(default=0, ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    subagent: Annotated[str | None, Field(max_length=40)] = None


class FactDraft(_StrictModel):
    statement: MediumText
    evidence_ids: list[EvidenceId] = Field(min_length=1, max_length=20)
    verification: Verification
    confidence: float = Field(ge=0.0, le=1.0)

    @field_validator("statement")
    @classmethod
    def _statement(cls, value: str) -> str:
        return _clean(value, field="fact.statement", limit=600)


class UncertaintyDraft(_StrictModel):
    question: MediumText
    why_unknown: MediumText
    impact_if_true: MediumText
    resolution_step: MediumText
    related_evidence_ids: list[EvidenceId] = Field(default_factory=list, max_length=20)

    @field_validator("question", "why_unknown", "impact_if_true", "resolution_step")
    @classmethod
    def _text(cls, value: str) -> str:
        return _clean(value, field="uncertainty", limit=600)


class ProposedActionDraft(_StrictModel):
    title: ShortText
    description: Annotated[str, Field(min_length=10, max_length=4000)]
    priority: TaskPriority
    rationale: MediumText
    evidence_ids: list[EvidenceId] = Field(default_factory=list, max_length=20)
    uncertainties: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("title", "description", "rationale")
    @classmethod
    def _text(cls, value: str) -> str:
        return _clean(value, field="proposed_action", limit=4000)


class RecommendationDraft(_StrictModel):
    # Bounds mirror the agent_submit_recommendation reducer (packages/shared/src/limits.ts):
    # title 3..200, description <=5000, rationale 10..4000.
    title: Annotated[str, Field(min_length=3, max_length=160)]
    description: Annotated[str, Field(min_length=10, max_length=5000)]
    priority: TaskPriority
    rationale: Annotated[str, Field(min_length=10, max_length=600)]
    facts: list[FactDraft] = Field(default_factory=list, max_length=50)
    uncertainties: list[UncertaintyDraft] = Field(default_factory=list, max_length=50)
    proposed_actions: list[ProposedActionDraft] = Field(default_factory=list, max_length=10)
    limitations: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(
        default_factory=list, max_length=10
    )

    @field_validator("title", "description", "rationale")
    @classmethod
    def _text(cls, value: str) -> str:
        return _clean(value, field="recommendation", limit=5000)

    @field_validator("limitations")
    @classmethod
    def _limitations(cls, value: list[str]) -> list[str]:
        return [_clean(item, field="limitation", limit=300) for item in value]


class Recommendation(_StrictModel):
    id: ShortText
    run_id: ShortText
    incident_id: ShortText
    organization_id: ShortText
    agent_run_id: ShortText
    title: ShortText
    description: Annotated[str, Field(min_length=1, max_length=5000)]
    priority: TaskPriority
    rationale: MediumText
    inference_mode: InferenceMode
    model_identifier: Annotated[str, Field(max_length=120)]
    status: RecommendationStatus = "PENDING"
    evidence_ids: list[EvidenceId] = Field(default_factory=list, max_length=20)
    facts: list[FactDraft] = Field(default_factory=list, max_length=50)
    uncertainties: list[UncertaintyDraft] = Field(default_factory=list, max_length=50)
    proposed_actions: list[ProposedActionDraft] = Field(default_factory=list, max_length=10)
    requires_human_approval: Literal[True] = True
    created_at: datetime
    decided_by: Annotated[str | None, Field(max_length=200)] = None
    decided_at: datetime | None = None
    decision_reason: Annotated[str, Field(max_length=1000)] = ""
    created_task_id: Annotated[str | None, Field(max_length=64)] = None


SubagentName = Literal["triage", "impact", "containment", "communications"]
SubagentStatus = Literal["PENDING", "RUNNING", "COMPLETED", "FAILED", "SKIPPED"]
SUBAGENT_ORDER: tuple[SubagentName, ...] = ("triage", "impact", "containment", "communications")


class SubagentRecord(_StrictModel):
    """Per-specialist progress (frozen web contract; order is SUBAGENT_ORDER)."""

    name: SubagentName
    status: SubagentStatus = "PENDING"
    summary: Annotated[str, Field(max_length=600)] = ""
    tool_calls: int = Field(default=0, ge=0)
    provider_calls: int = Field(default=0, ge=0)
    latency_ms: int = Field(default=0, ge=0)


def initial_subagents(status: SubagentStatus = "PENDING") -> list[SubagentRecord]:
    return [SubagentRecord(name=name, status=status) for name in SUBAGENT_ORDER]


class RunRecord(_StrictModel):
    run_id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    requested_by: Annotated[str, Field(max_length=200)]
    requested_role: Role
    status: RunStatus = "REQUESTED"
    inference_mode: InferenceMode
    model_identifier: Annotated[str, Field(max_length=120)]
    analysis_type: AnalysisType = "intake"
    exercise_label: Annotated[str, Field(max_length=40)] = "EXERCISE"
    focus: Annotated[str | None, Field(max_length=500)] = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error_category: Annotated[str | None, Field(max_length=60)] = None
    error_message: Annotated[str | None, Field(max_length=300)] = None
    summary: Annotated[str, Field(max_length=5000)] = ""
    tool_calls: list[ToolCallRecord] = Field(default_factory=list, max_length=40)
    provider_calls: list[ProviderCallRecord] = Field(default_factory=list, max_length=32)
    recommendation: Recommendation | None = None
    injection_suspected: bool = False
    redaction_counts: dict[str, int] = Field(default_factory=dict)
    agent_mode: Literal["orchestrated", "single"] = "orchestrated"
    subagents: list[SubagentRecord] = Field(default_factory=initial_subagents, max_length=4)
    sitrep: Annotated[str, Field(max_length=2000)] = ""


class ErrorBody(_StrictModel):
    code: str
    message: str
    request_id: str | None = None
    details: dict[str, object] = Field(default_factory=dict)


class ErrorEnvelope(_StrictModel):
    error: ErrorBody
