// SentinelZero v1 canonical enumerations. FROZEN: changes require integration-owner approval.
// Values are stored as strings in SpacetimeDB and validated server-side against these lists.

export const ROLES = ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER', 'OBSERVER'] as const;
export type Role = (typeof ROLES)[number];

export const INCIDENT_STATUSES = [
  'REPORTED',
  'TRIAGING',
  'INVESTIGATING',
  'CONTAINING',
  'CONTAINED',
  'RECOVERING',
  'RESOLVED',
  'CLOSED',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_CATEGORIES = [
  'RANSOMWARE',
  'DATA_EXFILTRATION',
  'ACCOUNT_COMPROMISE',
  'MALWARE',
  'PHISHING',
  'DENIAL_OF_SERVICE',
  'INSIDER',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const ASSET_TYPES = [
  'SERVER',
  'WORKSTATION',
  'DATABASE',
  'APPLICATION',
  'NETWORK_DEVICE',
  'IDENTITY_SYSTEM',
  'STORAGE',
  'CLOUD_RESOURCE',
  'OTHER',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_COMPROMISE = ['UNKNOWN', 'SUSPECTED', 'CONFIRMED', 'CONTAINED', 'RECOVERED'] as const;
export type AssetCompromise = (typeof ASSET_COMPROMISE)[number];

export const AVAILABILITY_STATUSES = ['UNKNOWN', 'AVAILABLE', 'DEGRADED', 'UNAVAILABLE'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const VERIFICATION = ['UNKNOWN', 'SUSPECTED', 'CONFIRMED', 'RULED_OUT'] as const;
export type Verification = (typeof VERIFICATION)[number];

export const CRITICALITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Criticality = (typeof CRITICALITY)[number];

export const DEPENDENCY_TYPES = ['HOSTS', 'STORES_DATA_FOR', 'AUTHENTICATES', 'NETWORK_PATH', 'INTEGRATES_WITH', 'OTHER'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const IMPACT_TYPES = ['SERVICE_OUTAGE', 'SERVICE_DEGRADATION', 'DATA_UNAVAILABLE', 'DATA_EXPOSURE_RISK', 'SAFETY_RISK', 'OTHER'] as const;
export type ImpactType = (typeof IMPACT_TYPES)[number];

export const CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const TASK_SOURCES = ['HUMAN', 'AI_RECOMMENDATION'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const DATA_SENSITIVITY = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'REGULATED'] as const;
export type DataSensitivity = (typeof DATA_SENSITIVITY)[number];

export const TASK_STATUSES = ['PENDING', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const APPROVAL_STATUSES = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TASK_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const EVIDENCE_TYPES = ['LOG_EXPORT', 'DISK_IMAGE_REF', 'MEMORY_IMAGE_REF', 'SCREENSHOT', 'RANSOM_NOTE', 'NETWORK_CAPTURE_REF', 'REPORT', 'OTHER'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_CLASSIFICATIONS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type EvidenceClassification = (typeof EVIDENCE_CLASSIFICATIONS)[number];

export const AGENT_RUN_STATUSES = ['REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const ANALYSIS_TYPES = ['intake', 'impact', 'response'] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

/** LIVE = genuine model inference; SIMULATED/FIXTURE must never be presented as live. */
export const INFERENCE_MODES = ['LIVE', 'SIMULATED', 'FIXTURE'] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];

export const AGENT_ERROR_CATEGORIES = [
  'NONE',
  'INVALID_JSON',
  'PROVIDER_OUTAGE',
  'RATE_LIMITED',
  'TIMEOUT',
  'UNSUPPORTED_TOOL',
  'CANCELLED',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const;
export type AgentErrorCategory = (typeof AGENT_ERROR_CATEGORIES)[number];

export const AGENT_TOOLS = ['get_incident', 'get_assets', 'get_dependencies', 'get_open_tasks', 'get_evidence_summaries', 'propose_task'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export const RECOMMENDATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** Data provenance label. Synthetic/demo organizations are EXERCISE. */
export const DATA_CLASSES = ['EXERCISE', 'LIVE'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export function isOneOf<T extends readonly string[]>(values: T, v: string): v is T[number] {
  return (values as readonly string[]).includes(v);
}
