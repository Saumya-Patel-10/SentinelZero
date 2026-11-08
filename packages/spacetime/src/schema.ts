import { schema, table, t } from 'spacetimedb/server';

// SECURITY: every table below is PRIVATE (no `public: true`). Clients never subscribe to these
// tables directly; they read only through the per-sender views in ./views, which re-check
// active membership and role on every evaluation. Do not add `public: true` to any table.
//
// IDs: opaque UUIDv7 strings generated server-side (context.newId). Unique, not secret.
// Enumerated fields are strings validated against packages/shared/src/enums.ts.

export const platformAdmin = table(
  { name: 'platform_admin' },
  {
    identity: t.identity().primaryKey(),
    createdAt: t.timestamp(),
  }
);

export const trustedIssuer = table(
  { name: 'trusted_issuer' },
  {
    issuer: t.string().primaryKey(),
    addedBy: t.identity(),
    addedAt: t.timestamp(),
  }
);

/**
 * Accepted `aud` values per trusted issuer. An issuer with no rows here is accepted for any
 * audience (weaker; production deployments must configure at least one).
 */
export const trustedAudience = table(
  { name: 'trusted_audience' },
  {
    /** `${issuer}\n${audience}` */
    key: t.string().primaryKey(),
    issuer: t.string().index('btree'),
    audience: t.string(),
    addedBy: t.identity(),
    addedAt: t.timestamp(),
  }
);

export const organization = table(
  { name: 'organization' },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    status: t.string(),
    dataClass: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
  }
);

export const userProfile = table(
  { name: 'user_profile' },
  {
    identity: t.identity().primaryKey(),
    displayName: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    disabledAt: t.option(t.timestamp()),
  }
);

export const membership = table(
  {
    name: 'membership',
    indexes: [{ accessor: 'by_org_user', algorithm: 'btree', columns: ['organizationId', 'userIdentity'] }],
  },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    userIdentity: t.identity().index('btree'),
    role: t.string(),
    grantedBy: t.identity(),
    createdAt: t.timestamp(),
    revokedAt: t.option(t.timestamp()),
    revokedBy: t.option(t.identity()),
    revokeReason: t.string(),
  }
);

/** Non-human principals (e.g. the FastAPI AI service). Never hold a membership role. */
export const servicePrincipal = table(
  {
    name: 'service_principal',
    indexes: [{ accessor: 'by_org_identity', algorithm: 'btree', columns: ['organizationId', 'identity'] }],
  },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    identity: t.identity().index('btree'),
    label: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    revokedAt: t.option(t.timestamp()),
  }
);

export const incident = table(
  { name: 'incident' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string().index('btree'),
    title: t.string(),
    description: t.string(),
    category: t.string(),
    severity: t.string(),
    status: t.string(),
    commanderIdentity: t.option(t.identity()),
    dataClass: t.string(),
    detectedAt: t.option(t.timestamp()),
    reportedAt: t.timestamp(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    version: t.u32(),
    /** Scoped idempotency key: `${organizationId}:${clientKey}`. */
    idempotencyKey: t.string().unique(),
  }
);

export const asset = table(
  { name: 'asset' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    name: t.string(),
    assetType: t.string(),
    criticality: t.string(),
    compromiseStatus: t.string(),
    availabilityStatus: t.string(),
    description: t.string(),
    lastVerifiedAt: t.option(t.timestamp()),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    version: t.u32(),
  }
);

export const service = table(
  { name: 'service' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    name: t.string(),
    description: t.string(),
    criticality: t.string(),
    availabilityStatus: t.string(),
    availabilityVerification: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    version: t.u32(),
  }
);

export const serviceDependency = table(
  { name: 'service_dependency' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    sourceAssetId: t.string(),
    targetServiceId: t.string(),
    dependencyType: t.string(),
    verification: t.string(),
    verifiedAt: t.option(t.timestamp()),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    /** `${incidentId}:${sourceAssetId}:${targetServiceId}:${dependencyType}` */
    dedupeKey: t.string().unique(),
  }
);

export const operationalImpact = table(
  { name: 'operational_impact' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    serviceId: t.string(),
    impactType: t.string(),
    severity: t.string(),
    verification: t.string(),
    /** Who may be affected (e.g. "outpatients"). Never inferred from dependency alone. */
    affectedGroup: t.string(),
    description: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    version: t.u32(),
  }
);

export const dataScope = table(
  { name: 'data_scope' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    assetId: t.string(),
    dataCategory: t.string(),
    sensitivity: t.string(),
    /** Ransomware encryption/locking. Distinct from exfiltration. */
    lockStatus: t.string(),
    exfiltrationStatus: t.string(),
    integrityStatus: t.string(),
    estimatedRecords: t.option(t.u64()),
    confidence: t.string(),
    evidenceId: t.string(),
    updatedBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    version: t.u32(),
    /** `${incidentId}:${assetId}:${dataCategory}` */
    scopeKey: t.string().unique(),
  }
);

export const task = table(
  { name: 'task' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    title: t.string(),
    description: t.string(),
    priority: t.string(),
    status: t.string(),
    assignedIdentity: t.option(t.identity()),
    approvalStatus: t.string(),
    approvedBy: t.option(t.identity()),
    decidedAt: t.option(t.timestamp()),
    decisionReason: t.string(),
    source: t.string(),
    sourceRecommendationId: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    version: t.u32(),
    /** Scoped idempotency key: `${incidentId}:${clientKey}` or `rec:${recommendationId}`. */
    idempotencyKey: t.string().unique(),
  }
);

export const message = table(
  { name: 'message' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    senderIdentity: t.identity(),
    content: t.string(),
    createdAt: t.timestamp(),
    /** `${senderHex}:${clientMessageId}` */
    dedupeKey: t.string().unique(),
  }
);

export const evidenceReference = table(
  { name: 'evidence_reference' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    evidenceType: t.string(),
    source: t.string(),
    sha256: t.string(),
    classification: t.string(),
    description: t.string(),
    recordedBy: t.identity(),
    recordedAt: t.timestamp(),
  }
);

export const auditEvent = table(
  { name: 'audit_event' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string().index('btree'),
    /** Empty string for organization-level events. */
    incidentId: t.string().index('btree'),
    /** Monotonic per organization; use for ordering (auto-inc ids are not ordered). */
    seq: t.u64(),
    actorIdentity: t.identity(),
    actorKind: t.string(),
    eventType: t.string(),
    targetId: t.string(),
    timestamp: t.timestamp(),
    metadata: t.string(),
    previousHash: t.string(),
    eventHash: t.string(),
  }
);

export const auditChainHead = table(
  { name: 'audit_chain_head' },
  {
    organizationId: t.string().primaryKey(),
    seq: t.u64(),
    lastHash: t.string(),
  }
);

export const agentRun = table(
  { name: 'agent_run' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    requestedBy: t.identity(),
    analysisType: t.string(),
    status: t.string(),
    claimedBy: t.option(t.identity()),
    modelIdentifier: t.string(),
    inferenceMode: t.string(),
    createdAt: t.timestamp(),
    startedAt: t.option(t.timestamp()),
    finishedAt: t.option(t.timestamp()),
    leaseExpiresAt: t.option(t.timestamp()),
    errorCategory: t.string(),
    summary: t.string(),
    /** `${requesterHex}:${clientKey}` */
    idempotencyKey: t.string().unique(),
  }
);

export const agentToolCall = table(
  { name: 'agent_tool_call' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    agentRunId: t.string().index('btree'),
    toolName: t.string(),
    inputSummary: t.string(),
    outputSummary: t.string(),
    status: t.string(),
    timestamp: t.timestamp(),
  }
);

export const recommendation = table(
  { name: 'recommendation' },
  {
    id: t.string().primaryKey(),
    organizationId: t.string(),
    incidentId: t.string().index('btree'),
    agentRunId: t.string().index('btree'),
    title: t.string(),
    description: t.string(),
    priority: t.string(),
    rationale: t.string(),
    evidenceIds: t.array(t.string()),
    uncertainties: t.array(t.string()),
    inferenceMode: t.string(),
    modelIdentifier: t.string(),
    status: t.string(),
    createdTaskId: t.string(),
    decidedBy: t.option(t.identity()),
    decidedAt: t.option(t.timestamp()),
    decisionReason: t.string(),
    createdAt: t.timestamp(),
    /** `${agentRunId}:${clientKey}` */
    dedupeKey: t.string().unique(),
  }
);

/** Scheduled sweep that expires stale agent runs (see agentReducers.sweep_agent_runs). */
export const agentRunSweepSchedule = table(
  { name: 'agent_run_sweep_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

export const rateLimit = table(
  { name: 'rate_limit' },
  {
    key: t.string().primaryKey(),
    windowStartMicros: t.i64(),
    count: t.u32(),
  }
);

/** Persistent counter that makes generated ids unique across transactions (see context.newId). */
export const idSequence = table(
  { name: 'id_sequence' },
  {
    name: t.string().primaryKey(),
    value: t.u64(),
  }
);

const spacetimedb = schema({
  platformAdmin,
  trustedIssuer,
  trustedAudience,
  organization,
  userProfile,
  membership,
  servicePrincipal,
  incident,
  asset,
  service,
  serviceDependency,
  operationalImpact,
  dataScope,
  task,
  message,
  evidenceReference,
  auditEvent,
  auditChainHead,
  agentRun,
  agentToolCall,
  recommendation,
  agentRunSweepSchedule,
  rateLimit,
  idSequence,
});

export default spacetimedb;
