# SentinelZero Data Model (v1, FROZEN)

Source of truth: `packages/spacetime/src/schema.ts`. Enum values are in `packages/shared/src/enums.ts`.

## Conventions

- **Every table is private.** Clients read only through the per-sender views listed in `docs/api-contracts.md` section 5.
- **IDs** are opaque UUIDv7 strings generated on the server by `newId` (`packages/spacetime/src/security/context.ts`). Clients never supply IDs for new rows. The UUID counter field comes from the persisted `id_sequence` counter, because `ctx.newUuidV7()` in 2.14.1 seeds its RNG only from the transaction timestamp and produced duplicate IDs (and a unique-constraint panic) when two transactions shared a timestamp. IDs are unique, **not secret**: authorization never depends on an ID being unguessable.
- **Enumerated fields** are `string` columns validated on every write against `packages/shared/src/enums.ts`. They are not SpacetimeDB sum types, so clients get readable values and enums can be extended without a breaking schema migration.
- **Actor columns** (`createdBy`, `grantedBy`, `senderIdentity`, `recordedBy`, `approvedBy`, `decidedBy`, `requestedBy`, `claimedBy`, `actorIdentity`) are always set from `ctx.sender`.
- **`version: u32`** provides optimistic concurrency on mutable rows. It starts at 1 and increments on every update.
- **Tenancy**: every incident-scoped row carries a denormalized `organizationId` and `incidentId`. Writes check that referenced rows belong to the same incident.
- **Uncertainty is preserved.** Verification fields default to `UNKNOWN`, and nothing is promoted to CONFIRMED implicitly. Ransomware lock status, exfiltration status and integrity status are three separate fields.
- **Simulated vs live**: `organization.dataClass` (EXERCISE or LIVE) is copied onto every incident. `agent_run.inferenceMode` and `recommendation.inferenceMode` (LIVE, SIMULATED or FIXTURE) label all AI output.

## Tables

### Identity and tenancy

| Table | Key | Purpose and notable columns |
|---|---|---|
| `platform_admin` | `identity` | Seeded by `init` with the publisher's identity |
| `trusted_issuer` | `issuer` | Optional JWT issuer allowlist, enforced in `onConnect` |
| `organization` | `id` | `name`, `status` (ACTIVE or SUSPENDED), `dataClass` |
| `user_profile` | `identity` | `displayName`, `disabledAt?` (platform-level kill switch) |
| `membership` | `id`; indexes `by_org_user(organizationId, userIdentity)` and `userIdentity` | `role`, `grantedBy`, `revokedAt?`, `revokedBy?`, `revokeReason`. Revocation is a soft delete. At most one active membership per (org, user) |
| `service_principal` | `id`; indexes `by_org_identity`, `identity` | Non-human identity (the AI service). It never holds a membership, and a human member (including a currently disabled one) cannot be registered as one |

### Incident and impact graph

| Table | Key / unique | Notable columns |
|---|---|---|
| `incident` | `id`; unique `idempotencyKey = <orgId>:<clientKey>` | `title`, `description`, `category`, `severity`, `status`, `commanderIdentity?`, `dataClass`, `detectedAt?`, `reportedAt`, `version` |
| `asset` | `id`; index `incidentId` | `assetType`, `criticality`, `compromiseStatus`, `availabilityStatus`, `lastVerifiedAt?`, `version` |
| `service` | `id`; index `incidentId` | `criticality`, `availabilityStatus`, `availabilityVerification`, `version` |
| `service_dependency` | `id`; unique `dedupeKey = <incident>:<asset>:<service>:<type>` | asset → service edge with `dependencyType`, `verification`, `verifiedAt?` |
| `operational_impact` | `id` | `serviceId`, `impactType`, `severity`, `verification`, `affectedGroup` (explicit, never inferred), `version` |
| `data_scope` | `id`; unique `scopeKey = <incident>:<asset>:<dataCategory>` | `sensitivity`, `lockStatus`, `exfiltrationStatus`, `integrityStatus`, `estimatedRecords?`, `confidence`, `evidenceId` |

### Work, communication, evidence

| Table | Key / unique | Notable columns |
|---|---|---|
| `task` | `id`; unique `idempotencyKey = <incidentId>:<clientKey>` or `rec:<recommendationId>` | `priority`, `status`, `assignedIdentity?`, `approvalStatus` (NOT_REQUIRED, PENDING, APPROVED or REJECTED), `approvedBy?`, `decidedAt?`, `decisionReason`, `source` (HUMAN or AI_RECOMMENDATION), `sourceRecommendationId`, `version` |
| `message` | `id`; unique `dedupeKey = <senderHex>:<clientMessageId>` | `senderIdentity`, `content` (untrusted text) |
| `evidence_reference` | `id` | Append-only. `evidenceType`, `source`, `sha256`, `classification`, `description`. Stores metadata only, never file contents |

### Audit

| Table | Key | Notable columns |
|---|---|---|
| `audit_event` | `id`; indexes `organizationId`, `incidentId` | `seq` (monotonic per org), `actorIdentity`, `actorKind` (USER, SERVICE or PLATFORM), `eventType`, `targetId`, `timestamp`, `metadata` (JSON with **no** message text, tokens or secrets), `previousHash`, `eventHash` |
| `audit_chain_head` | `organizationId` | `seq`, `lastHash` |

The hash is computed as:

```
eventHash = sha256_hex(orgId \n incidentId \n seq \n actorHex \n actorKind \n eventType \n targetId \n timestampMicros \n metadata \n previousHash)
```

The genesis `previousHash` is 64 zeros. `computeAuditHash` is in `packages/spacetime/src/security/auditHash.ts`. To verify a chain, sort `my_audit_events` by `seq` and recompute every hash, as `workflows.test.ts` does.

### AI

| Table | Key / unique | Notable columns |
|---|---|---|
| `agent_run` | `id`; unique `idempotencyKey = <requesterHex>:<clientKey>` | `requestedBy`, `analysisType`, `status`, `claimedBy?`, `modelIdentifier`, `inferenceMode`, `startedAt?`, `finishedAt?`, `leaseExpiresAt?`, `errorCategory`, `summary` |
| `agent_tool_call` | `id`; index `agentRunId` | `toolName`, `inputSummary`, `outputSummary` (counts and IDs only), `status` |
| `recommendation` | `id`; unique `dedupeKey = <runId>:<clientKey>` | `title`, `description`, `priority`, `rationale`, `evidenceIds[]`, `uncertainties[]`, `inferenceMode`, `modelIdentifier`, `status`, `createdTaskId`, `decidedBy?`, `decidedAt?`, `decisionReason` |

### Housekeeping

| Table | Purpose |
|---|---|
| `agent_run_sweep_schedule` | Runs the scheduled reducer `sweep_agent_runs` every 60 s, internal only, to expire stale runs |
| `rate_limit` | Fixed-window counters keyed by `<action>:<senderHex>`. Actions and budgets are `RATE_LIMITS` in `packages/shared/src/limits.ts` |
| `id_sequence` | Single row (`name = 'id'`) holding the counter used by `newId` |

## Invariants enforced on the server

1. A write requires an active membership (organization ACTIVE, user not disabled, membership not revoked) with the required capability (`packages/shared/src/permissions.ts`).
2. Non-members get `INCIDENT_NOT_FOUND` for incident-scoped calls, which does not reveal whether the incident exists.
3. The organization always has at least one active OWNER who is not disabled.
4. Incident and task status changes follow `incidentLifecycle.ts` and `taskLifecycle.ts`. A CLOSED incident and all its children are read-only until a COMMANDER reopens it. The only writes still accepted on a CLOSED incident are the reopen transition, `cancel_agent_run` and `agent_complete_run` (winding down a run that was already started).
5. A recommendation creates at most one task. This is guaranteed by both a status check and the unique task key `rec:<id>`.
6. AI recommendations are always created PENDING and must cite evidence from the same incident or state uncertainties.
7. Every privileged mutation appends a hash-chained `audit_event` in the same transaction.

## Enums (summary; values are in `enums.ts`)

| Group | Enums |
|---|---|
| Roles and incidents | `ROLES` (OWNER, COMMANDER, ANALYST, RESPONDER, OBSERVER), `INCIDENT_STATUSES`, `SEVERITIES`, `INCIDENT_CATEGORIES` |
| Assets and verification | `ASSET_TYPES`, `ASSET_COMPROMISE`, `AVAILABILITY_STATUSES`, `VERIFICATION` (UNKNOWN, SUSPECTED, CONFIRMED, RULED_OUT), `CRITICALITY`, `CONFIDENCE` |
| Tasks | `TASK_STATUSES`, `APPROVAL_STATUSES`, `TASK_PRIORITIES`, `TASK_SOURCES` |
| Graph, data, evidence | `DEPENDENCY_TYPES`, `IMPACT_TYPES`, `DATA_SENSITIVITY`, `EVIDENCE_TYPES`, `EVIDENCE_CLASSIFICATIONS` |
| AI | `AGENT_RUN_STATUSES`, `ANALYSIS_TYPES`, `INFERENCE_MODES`, `AGENT_ERROR_CATEGORIES`, `AGENT_TOOLS`, `RECOMMENDATION_STATUSES` |
| Organizations | `DATA_CLASSES`, `ORGANIZATION_STATUSES` |
