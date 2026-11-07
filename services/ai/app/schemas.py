"""Pydantic contracts for backend context, model output, runs, and API views.

Evidence-linked facts are structurally required to cite known evidence ids. The
validator in ``app.llm.structured_output`` additionally rejects fabricated ids.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.security.guardrails import clean_text

Role = Literal["OWNER", "COMMANDER", "ANALYST", "RESPONDER", "OBSERVER"]
VerificationStatus = Literal["UNKNOWN", "SUSPECTED", "CONFIRMED", "RULED_OUT"]
Priority = Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
RunStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]
EvidenceBasis = Literal["EVIDENCE_BACKED", "CONTINUITY_PRACTICE", "UNVERIFIED_INFERENCE"]
RiskLevel = Literal["LOW", "MEDIUM", "HIGH"]
ProviderMode = Literal["live", "scripted"]

EvidenceId = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")]
ShortText = Annotated[str, Field(min_length=1, max_length=160)]
MediumText = Annotated[str, Field(min_length=1, max_length=600)]
LongText = Annotated[str, Field(min_length=1, max_length=1_500)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class _ContextModel(BaseModel):
    """Backend records may include forward-compatible fields; ignore them."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


def _clean(value: str, *, field: str, limit: int) -> str:
    try:
        return clean_text(value, field_name=field, max_length=limit)
    except ValueError as exc:  # surface as a normal validation error
        raise ValueError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Backend context (Agent 1 contract; MOCK implementations in this branch)
# ---------------------------------------------------------------------------
class IncidentContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    title: ShortText
    description: Annotated[str, Field(max_length=6_000)] = ""
    category: ShortText
    severity: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
    status: Literal[
        "REPORTED", "TRIAGING", "INVESTIGATING", "CONTAINING",
        "CONTAINED", "RECOVERING", "RESOLVED", "CLOSED",
    ]
    commander_identity: Annotated[str, Field(max_length=200)]
    detected_at: datetime
    reported_at: datetime
    exercise_label: Annotated[str, Field(max_length=40)] = "EXERCISE"

    @field_validator("description")
    @classmethod
    def _safe_description(cls, value: str) -> str:
        return _clean(value, field="incident.description", limit=6_000)


class AssetContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    name: ShortText
    type: Annotated[str, Field(max_length=60)]
    criticality: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    compromise_status: VerificationStatus
    availability_status: Literal["OPERATIONAL", "DEGRADED", "UNAVAILABLE", "UNKNOWN"]
    last_verified_at: datetime
    evidence_reference: Annotated[str, Field(max_length=100)] | None = None


class ServiceContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    name: ShortText
    criticality: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    status: Literal["OPERATIONAL", "DEGRADED", "UNAVAILABLE", "UNKNOWN"]


class ServiceDependencyContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    source_asset_id: ShortText
    target_service_id: ShortText
    type: Annotated[str, Field(max_length=60)]
    confidence: float = Field(ge=0.0, le=1.0)
    verified_at: datetime | None = None


class OperationalImpactContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    service_id: ShortText
    impact_type: Annotated[str, Field(max_length=80)]
    severity: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
    verification_status: VerificationStatus
    description: Annotated[str, Field(max_length=1_000)]


class TaskContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    title: ShortText
    priority: Priority
    status: Literal["PENDING", "AWAITING_APPROVAL", "IN_PROGRESS", "BLOCKED", "COMPLETED", "CANCELLED"]
    assigned_identity: Annotated[str, Field(max_length=200)] | None = None
    approval_status: Literal["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"] = "PENDING"


class EvidenceSummary(_ContextModel):
    id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    type: Annotated[str, Field(max_length=80)]
    source: Annotated[str, Field(max_length=200)]
    sha256_prefix: Annotated[str, Field(pattern=r"^[a-f0-9]{8,64}$")]
    classification: Annotated[str, Field(max_length=80)]
    recorded_at: datetime


class DataScopeContext(_ContextModel):
    id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    asset_id: ShortText
    data_category: Annotated[str, Field(max_length=80)]
    sensitivity: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    lock_status: Literal["LOCKED", "UNLOCKED", "UNKNOWN"]
    exfiltration_status: VerificationStatus
    integrity_status: VerificationStatus
    estimated_records: int | None = Field(default=None, ge=0)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_reference: Annotated[str, Field(max_length=100)] | None = None


class AuthorizationDecision(_ContextModel):
    allowed: bool
    role: Role | None = None
    incident: IncidentContext | None = None
    reason: Annotated[str, Field(max_length=200)] | None = None


# ---------------------------------------------------------------------------
# Model output drafts (validated after inference)
# ---------------------------------------------------------------------------
class FactDraft(_StrictModel):
    statement: MediumText
    evidence_ids: list[EvidenceId] = Field(min_length=1, max_length=8)
    confidence: float = Field(ge=0.0, le=1.0)
    verification_status: VerificationStatus

    @field_validator("statement")
    @classmethod
    def _statement(cls, value: str) -> str:
        return _clean(value, field="fact.statement", limit=600)


class UncertaintyDraft(_StrictModel):
    question: MediumText
    why_unknown: MediumText
    impact_if_true: MediumText
    resolution_step: MediumText
    related_evidence_ids: list[EvidenceId] = Field(default_factory=list, max_length=8)

    @field_validator("question", "why_unknown", "impact_if_true", "resolution_step")
    @classmethod
    def _text(cls, value: str) -> str:
        return _clean(value, field="uncertainty", limit=600)


class ProposedTaskDraft(_StrictModel):
    title: ShortText
    description: Annotated[str, Field(min_length=5, max_length=1_200)]
    priority: Priority
    rationale: MediumText
    evidence_ids: list[EvidenceId] = Field(default_factory=list, max_length=8)
    evidence_basis: EvidenceBasis
    risk_level: RiskLevel
    assigned_role: Literal["ANALYST", "RESPONDER", "COMMANDER"] | None = None
    # Literal True makes it impossible for model output to mark a task approved.
    requires_human_approval: Literal[True] = True

    @field_validator("title", "description", "rationale")
    @classmethod
    def _text(cls, value: str) -> str:
        return _clean(value, field="proposed_task", limit=1_200)


class RecommendationDraft(_StrictModel):
    summary: LongText
    facts: list[FactDraft] = Field(default_factory=list, max_length=8)
    uncertainties: list[UncertaintyDraft] = Field(default_factory=list, max_length=8)
    proposed_tasks: list[ProposedTaskDraft] = Field(default_factory=list, max_length=5)
    limitations: list[Annotated[str, Field(max_length=400)]] = Field(default_factory=list, max_length=5)

    @field_validator("summary")
    @classmethod
    def _summary(cls, value: str) -> str:
        return _clean(value, field="summary", limit=1_500)


class Recommendation(_StrictModel):
    recommendation_id: ShortText
    run_id: ShortText
    incident_id: ShortText
    organization_id: ShortText
    created_at: datetime
    model_identifier: Annotated[str, Field(max_length=120)]
    provider_mode: ProviderMode
    inference_label: Annotated[str, Field(max_length=60)]
    approval_status: Literal["PENDING_HUMAN_APPROVAL"] = "PENDING_HUMAN_APPROVAL"
    submitted: bool = False
    submitted_reference: Annotated[str, Field(max_length=160)] | None = None
    exercise_label: Annotated[str, Field(max_length=40)] = "EXERCISE"
    summary: LongText
    facts: list[FactDraft] = Field(default_factory=list, max_length=8)
    uncertainties: list[UncertaintyDraft] = Field(default_factory=list, max_length=8)
    proposed_tasks: list[ProposedTaskDraft] = Field(default_factory=list, max_length=5)
    limitations: list[Annotated[str, Field(max_length=400)]] = Field(default_factory=list, max_length=5)
    evidence_ids_used: list[EvidenceId] = Field(default_factory=list, max_length=32)
    injection_suspected: bool = False
    redaction_counts: dict[str, int] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Run records
# ---------------------------------------------------------------------------
class ToolCallRecord(_StrictModel):
    id: ShortText
    tool_name: Annotated[str, Field(max_length=60)]
    input_summary: dict[str, object] = Field(default_factory=dict)
    output_summary: dict[str, object] = Field(default_factory=dict)
    status: Literal["OK", "ERROR", "DENIED"]
    timestamp: datetime
    duration_ms: int = Field(ge=0)


class ProviderCallRecord(_StrictModel):
    step: int = Field(ge=1)
    model_identifier: Annotated[str, Field(max_length=120)]
    endpoint_class: Annotated[str, Field(max_length=60)]
    status: Literal["OK", "ERROR"]
    latency_ms: int = Field(ge=0)
    finish_reason: Annotated[str, Field(max_length=40)] | None = None
    tool_calls: int = Field(default=0, ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)


class RunRecord(_StrictModel):
    run_id: ShortText
    organization_id: ShortText
    incident_id: ShortText
    requested_by: Annotated[str, Field(max_length=200)]
    requested_role: Role
    status: RunStatus = "QUEUED"
    provider_mode: ProviderMode
    endpoint_class: Annotated[str, Field(max_length=60)]
    inference_label: Annotated[str, Field(max_length=60)]
    model_identifier: Annotated[str, Field(max_length=120)]
    exercise_label: Annotated[str, Field(max_length=40)] = "EXERCISE"
    focus: Annotated[str, Field(max_length=500)] | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error_category: Annotated[str, Field(max_length=60)] | None = None
    error_message: Annotated[str, Field(max_length=300)] | None = None
    tool_calls: list[ToolCallRecord] = Field(default_factory=list, max_length=32)
    provider_calls: list[ProviderCallRecord] = Field(default_factory=list, max_length=16)
    recommendation: Recommendation | None = None
    injection_suspected: bool = False
    redaction_counts: dict[str, int] = Field(default_factory=dict)


class AgentRunList(_StrictModel):
    runs: list[RunRecord]


class AnalysisRequest(_StrictModel):
    focus: Annotated[str, Field(max_length=500)] | None = None

    @field_validator("focus")
    @classmethod
    def _focus(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _clean(value, field="focus", limit=500)


class AnalysisAccepted(_StrictModel):
    run_id: ShortText
    status: RunStatus
    incident_id: ShortText
    provider_mode: ProviderMode
    inference_label: Annotated[str, Field(max_length=60)]
    live_inference: bool
    exercise_label: Annotated[str, Field(max_length=40)]
    notice: Annotated[str, Field(max_length=300)]


class SubmissionResult(_StrictModel):
    recommendation_id: ShortText
    run_id: ShortText
    backend_reference: Annotated[str, Field(max_length=160)]
    approval_status: Literal["PENDING_HUMAN_APPROVAL"] = "PENDING_HUMAN_APPROVAL"
    submitted: bool = True
    duplicate: bool = False
    message: Annotated[str, Field(max_length=300)]


class ErrorBody(_StrictModel):
    code: str
    message: str
    request_id: str | None = None
    details: dict[str, object] = Field(default_factory=dict)


class ErrorEnvelope(_StrictModel):
    error: ErrorBody
