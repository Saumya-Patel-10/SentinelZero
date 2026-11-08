# SentinelZero Integration Contract

| | |
|---|---|
| Contract version | **1.1.0**. The server reports it in the `backend_info` view, and `CONTRACT_VERSION` in `packages/shared/src/contract.ts` must match |
| Status | **Frozen for live integration.** Any change needs a new version, a changelog entry here, and a note to the web (Antigravity) and AI (OpenCode) owners. Nothing changes silently |
| Owner | Backend and contracts agent: `packages/spacetime/**`, `packages/shared/**`, bindings, root workspace config, this file, `docs/SECURITY_MODEL.md` |
| Supersedes | `docs/api-contracts.md` (v1.0) |

The code is the source of truth. If this document disagrees with the code, the code wins, and the drift should be reported to the owner. Every SDK call in this document either appears in `packages/spacetime/examples/clientExample.ts` or is checked against the generated 2.14.1 bindings. That example file is typechecked and executed by `tests/integration/contractExample.test.ts`.

## 0. Changelog

**1.1.0** (additive; existing 1.0 databases upgrade in place, verified by `scripts/migration-check.mjs`)

- **New views:**
  - `backend_info`: readable anonymously. Reports the contract version and issuer-policy state.
  - `my_incident_timeline`: the audit trail without metadata or hashes. Readable by RESPONDER and above.
  - `my_audit_chain_heads`: the server's head of each organization's hash chain, used by the audit verifier.
- **New table and reducers:** a `trusted_audience` table with the `add_trusted_audience` and `remove_trusted_audience` reducers.
- **Stricter issuer policy.** Once enforced, the policy now also checks a token's audience, its expiry and a maximum lifetime of 24 hours (see section 3). Enrolled machine identities, meaning platform admins and active service principals, are exempt.
- **Shared audit verifier.** `verifyAuditChain` is now exported from `packages/shared/src/auditChain.ts` (package export `@sentinelzero/shared/audit`).
- **Behaviour change for 1.0 users:** `remove_trusted_issuer` now also removes the audiences recorded for that issuer.

## 1. Pinned versions and locations

| Component | Version |
|---|---|
| SpacetimeDB CLI and standalone server | **2.14.1** (CLI commit `a0bf6be`) |
| `spacetimedb` npm package (server module **and** client SDK) | **2.14.1** (exact). Clients must use the same version as the generated bindings |
| `@noble/hashes` / `zod` | 2.4.0 / 4.6.7 |
| TypeScript / Vitest | 5.6.3 / 3.2.4 |
| Node.js | >= 20 (verified on 24.x and 26.x) |

| What | Where |
|---|---|
| Generated TypeScript client (commit it; regenerate only with the 2.14.1 CLI) | `packages/spacetime/bindings/` (`index.ts` exports `DbConnection`, tables, reducers and procedures) |
| Enums, limits, role matrix, state machines, graph transform, error parser | `packages/shared/src/*.ts` |
| Audit-chain verifier | `packages/shared/src/auditChain.ts` |
| Browser ↔ AI service request and response schemas (Zod) | `packages/shared/src/schemas.ts` |
| AI service ↔ SpacetimeDB wire format, plus the reference decoders | `packages/shared/src/agentContracts.ts` |
| Reference client (verified) | `packages/spacetime/examples/clientExample.ts` |

To regenerate the bindings after a schema change, run this from `packages/spacetime`:

```powershell
& $env:SPACETIME_CLI generate --lang typescript --out-dir ./bindings --module-path . --yes
```

## 2. Connecting

SpacetimeDB is the backend. There are **no `/api` REST routes** for incident data. Clients use the generated `DbConnection` over the SpacetimeDB protocol. The only HTTP calls are the SpacetimeDB HTTP API, which is used by server-side callers such as the AI service, scripts and tests.

```ts
import { DbConnection } from '<repo>/packages/spacetime/bindings';

DbConnection.builder()
  .withUri(import.meta.env.VITE_STDB_URI)            // e.g. http://127.0.0.1:3000 (tests use http://; the SDK derives the socket URL)
  .withDatabaseName(import.meta.env.VITE_STDB_DB_NAME) // e.g. sentinelzero
  .withToken(idToken)                                // see section 3
  .onConnect((conn, identity, token) => { /* subscribe */ })
  .onConnectError((_ctx, err) => { /* "backend unavailable" or "sign in again" */ })
  .build();
```

**Never** build a WebSocket URL or put a token in a query string yourself. The SDK performs its own exchange, described in section 3.4.

### 2.1 Subscriptions (the read API)

All base tables are **private**. Clients read only the per-sender views listed below. Each view re-checks the caller's **active** membership and role every time it is evaluated. Subscribe with `SELECT * FROM <view>` and filter by `incidentId` on the client. `COMMAND_CENTER_QUERIES` in the example is the recommended set:

```ts
conn.subscriptionBuilder()
  .onApplied(() => { /* initial snapshot ready */ })
  .onError(ctx => { /* error state */ })
  .subscribe(['SELECT * FROM my_incidents', 'SELECT * FROM my_tasks' /* … */]);

conn.db.myIncidents.onInsert((_ctx, row) => {});   // also onUpdate / onDelete
const tasks = [...conn.db.myTasks.iter()].filter(t => t.incidentId === selectedId);
```

The Who column uses these abbreviations: O = OWNER, C = COMMANDER, A = ANALYST, R = RESPONDER, Ob = OBSERVER. Callers outside the listed roles get **zero rows**, never an error.

| View (client accessor) | Row type | Who | Notes |
|---|---|---|---|
| `backend_info` (`backendInfo`) | `BackendInfoRow {contractVersion, issuerPolicyEnforced, trustedIssuerCount}` | anyone, including anonymous | check `contractVersion === CONTRACT_VERSION` on startup |
| `my_profile` (`myProfile`) | `UserProfile` | any identity | own profile |
| `my_memberships` (`myMemberships`) | `Membership` | any identity | includes **revoked** memberships, so the UI can say "access revoked" |
| `my_organizations` (`myOrganizations`) | `Organization` | O C A R Ob | active memberships only |
| `org_member_directory` (`orgMemberDirectory`) | `MemberDirectoryEntry {membershipId, organizationId, userIdentity, displayName, role}` | O C A R | for assignment pickers |
| `my_incident_summaries` (`myIncidentSummaries`) | `IncidentSummary {id, organizationId, title, category, severity, status, dataClass, reportedAt, updatedAt}` | O C A R Ob | the only incident data an OBSERVER gets |
| `my_incidents` (`myIncidents`) | `Incident` | O C A R | includes `version`, which writes need |
| `my_incident_timeline` (`myIncidentTimeline`) | `TimelineEntry {id, organizationId, incidentId, seq, actorIdentity, actorKind, eventType, targetId, timestamp}` | O C A R | audit trail **without** metadata or hashes |
| `my_assets`, `my_services`, `my_service_dependencies`, `my_operational_impacts` | graph rows | O C A R | input to `buildImpactGraph` |
| `my_data_scopes` (`myDataScopes`) | `DataScope` | O C A | sensitive |
| `my_evidence` (`myEvidence`) | `EvidenceReference` | O C A | metadata and SHA-256 hash only, never file contents |
| `my_tasks` (`myTasks`) | `Task` | O C A R | |
| `my_messages` (`myMessages`) | `Message` | O C A R | untrusted text; render as text, never as HTML |
| `my_agent_runs`, `my_agent_tool_calls`, `my_recommendations` | AI activity | O C A | always show `inferenceMode` |
| `my_audit_events` (`myAuditEvents`) | `AuditEvent` | O C A | full chain, input to `verifyAuditChain` |
| `my_audit_chain_heads` (`myAuditChainHeads`) | `AuditChainHead {organizationId, seq, lastHash}` | O C A | the server's chain head per organization |
| `my_service_principals` (`myServicePrincipals`) | `ServicePrincipal` | O | |

**Revocation is live.** When a membership is revoked or a user is disabled, the affected rows are deleted from the client cache of **existing** subscriptions and `onDelete` fires. No reconnect is needed. This is verified by `revocation.test.ts` and `negativeSecurity.test.ts`.

**Graph.** Pass `my_assets`, `my_services`, `my_service_dependencies` and `my_operational_impacts` to `buildImpactGraph(incidentId, {assets, services, dependencies, impacts})` from `packages/shared/src/graph.ts`. It returns `{nodes, edges}` for React Flow. Impact groups come only from explicit `operational_impact` rows.

### 2.2 Reducers (the write API)

To call a reducer, use `await conn.reducers.<camelName>({...named args})`. The promise resolves after the transaction commits. It rejects with an `Error` whose message is `"<CODE>: <detail>"`; parse it with `parseBackendError(e.message)` from `packages/shared/src/errors.ts`.

General rules:

- **Server-derived actor.** Reducers **never** accept an actor, role, user ID or membership in their arguments. The actor is always `ctx.sender`.
- **`expectedVersion`** is optimistic concurrency. Pass the `version` you displayed. A stale value fails with `VERSION_CONFLICT`; on success the version increments by 1.
- **`idempotencyKey`, `clientKey` and `clientMessageId`** are 8-128 characters matching `[A-Za-z0-9._:-]`. Repeating a call with the same key is a no-op that returns success.
- **Text fields** reject control characters, bidi overrides and blank-only values. HTML is stored verbatim, so escape it when rendering.
- **Optional strings.** Pass `''` for "not provided" (for example `evidenceId` and `reason`) unless the reducer requires the value. Pass `undefined` for an optional `Identity`, `Timestamp` or `u64`.
- **Closed incidents.** Writes to child records of a CLOSED incident fail with `INVALID_TRANSITION`.
- **Enum values** come from `packages/shared/src/enums.ts`. Never redefine the literals.

**Platform and organization**

| Reducer (`conn.reducers.*`) | Named arguments | Who |
|---|---|---|
| `add_trusted_issuer` / `remove_trusted_issuer` (`addTrustedIssuer` / `removeTrustedIssuer`) | `{issuer}` | platform admin. Removing an issuer also removes its audiences |
| `add_trusted_audience` / `remove_trusted_audience` | `{issuer, audience}` | platform admin. The issuer must already be trusted, otherwise `NOT_FOUND` |
| `create_organization` | `{name, dataClass: 'EXERCISE'\|'LIVE'}` | platform admin, who becomes an OWNER |
| `set_user_disabled` | `{userIdentity: Identity, disabled: boolean}` | platform admin |
| `register_profile` | `{displayName}` | any identity |
| `invite_member` | `{organizationId, userIdentity: Identity, role}` | OWNER |
| `revoke_member` | `{membershipId, reason}` | OWNER. Idempotent; cannot remove the last OWNER |
| `register_service_principal` | `{organizationId, identity: Identity, label}` | OWNER. The identity must not be a human member or a platform admin |
| `revoke_service_principal` | `{servicePrincipalId}` | OWNER |

**Incidents**

| Reducer | Named arguments | Who |
|---|---|---|
| `create_incident` | `{organizationId, title, description, category, severity, detectedAt?: Timestamp, idempotencyKey}` | O C A |
| `update_incident` | `{incidentId, expectedVersion, title, description, category, severity}` | O C A |
| `transition_incident_status` | `{incidentId, expectedVersion, toStatus, reason, evidenceId}` | O C. Reopening (RESOLVED or CLOSED to INVESTIGATING) is COMMANDER only and needs a reason of at least 10 characters. `evidenceId` must be evidence on the same incident, or `''` |
| `assign_incident_commander` | `{incidentId, expectedVersion, commanderIdentity: Identity}` | O C. The target must be an active COMMANDER |

**Scope: assets, services, dependencies, impacts and data**

| Reducer | Named arguments | Who |
|---|---|---|
| `add_asset` | `{incidentId, name, assetType, criticality, compromiseStatus, availabilityStatus, description}` | O C A |
| `update_asset_status` | `{assetId, expectedVersion, compromiseStatus, availabilityStatus, verifiedNow, reason}` | O C A |
| `add_service` | `{incidentId, name, description, criticality, availabilityStatus, availabilityVerification}` | O C A |
| `update_service_status` | `{serviceId, expectedVersion, availabilityStatus, availabilityVerification, reason}` | O C A |
| `add_service_dependency` | `{incidentId, sourceAssetId, targetServiceId, dependencyType, verification}` | O C A (deduplicated) |
| `update_dependency_verification` | `{dependencyId, verification, reason}` | O C A |
| `add_operational_impact` | `{incidentId, serviceId, impactType, severity, verification, affectedGroup, description}` | O C A |
| `update_operational_impact` | `{impactId, expectedVersion, severity, verification, description}` | O C A |
| `update_data_scope` | `{incidentId, assetId, dataCategory, sensitivity, lockStatus, exfiltrationStatus, integrityStatus, estimatedRecords?: bigint, confidence, evidenceId}` | O C A. Upserts by (incident, asset, category) |

**Tasks, messages and evidence**

| Reducer | Named arguments | Who |
|---|---|---|
| `create_task` | `{incidentId, title, description, priority, assignedIdentity?: Identity, requiresApproval, idempotencyKey}` | O C A. `requiresApproval` creates the task as AWAITING_APPROVAL |
| `assign_task` | `{taskId, expectedVersion, assignedIdentity?: Identity}` | O C A. The assignee must be active and not an OBSERVER |
| `update_task_status` | `{taskId, expectedVersion, toStatus, note}` | the assignee, or O C A. Setting CANCELLED requires O C A |
| `approve_task` / `reject_task` | `{taskId, reason}` | O C. Repeating the same decision is a no-op; the opposite decision fails with `INVALID_TRANSITION` |
| `send_message` | `{incidentId, content, clientMessageId}` | O C A R. Limited to 30 per 60 s |
| `append_evidence_reference` | `{incidentId, evidenceType, source, sha256 (64 lowercase hex), classification, description}` | O C A. Append-only |

**AI (human side)**

| Reducer | Named arguments | Who |
|---|---|---|
| `request_agent_run` | `{incidentId, analysisType: 'intake'\|'impact'\|'response', idempotencyKey}` | O C A. Limited to 5 per 60 s |
| `cancel_agent_run` | `{runId, reason}` | the requester, or O C |
| `approve_recommendation` | `{recommendationId, assignedIdentity?: Identity, reason}` | O C. Atomically creates **exactly one** task (`source = AI_RECOMMENDATION`, idempotency key `rec:<id>`) and one audit event, even under concurrent or repeated calls |
| `reject_recommendation` | `{recommendationId, reason}` | O C |

The AI-only reducers and procedures (`agent_*` and `verify_agent_run_access`) are in section 5.

### 2.3 State machines

These are defined in `packages/shared/src/incidentLifecycle.ts` and `taskLifecycle.ts`.

```
Incident: REPORTED -> TRIAGING | CLOSED          TRIAGING -> INVESTIGATING | CLOSED
          INVESTIGATING -> CONTAINING | RESOLVED  CONTAINING -> CONTAINED | INVESTIGATING
          CONTAINED -> RECOVERING | CONTAINING    RECOVERING -> RESOLVED | CONTAINING
          RESOLVED -> CLOSED                      reopen: RESOLVED | CLOSED -> INVESTIGATING (COMMANDER, reason >= 10)
Task:     AWAITING_APPROVAL -> PENDING (approve) | CANCELLED (reject)
          PENDING -> IN_PROGRESS | BLOCKED | CANCELLED     IN_PROGRESS -> BLOCKED | COMPLETED | CANCELLED
          BLOCKED -> IN_PROGRESS | CANCELLED               COMPLETED, CANCELLED: terminal
Agent run: REQUESTED -> RUNNING (15 min lease) -> COMPLETED | FAILED; CANCELLED from REQUESTED|RUNNING;
           sweep: REQUESTED > 10 min or lease expired -> EXPIRED
Recommendation: PENDING -> APPROVED (creates the task) | REJECTED
```

### 2.4 Errors

| Code | Meaning | UI behaviour |
|---|---|---|
| `AUTH_REQUIRED` | the connection was refused by the issuer policy or because the account is disabled (section 3) | send the user to sign-in |
| `ACCESS_DENIED` | the caller is a member but the role lacks the capability (or is not a member, for organization-level calls) | "not permitted" |
| `INCIDENT_NOT_FOUND` | the incident does not exist **or** the caller cannot see it; the two cases are deliberately indistinguishable | "not found" |
| `NOT_FOUND` | another referenced record is missing | |
| `INVALID_TRANSITION` | a state-machine violation, a closed incident, or a conflicting decision | refresh |
| `VALIDATION_FAILED` | bad enum value, length, characters or format | field error |
| `VERSION_CONFLICT` | stale `expectedVersion` | reload the row and let the user retry |
| `RATE_LIMITED` | too many requests | back off |
| `SERVICE_UNAVAILABLE` | client-side mapping for network failures or any untyped non-2xx response | retry later; never fabricate data |

The detail text is safe to show to users. It never contains secrets or another tenant's data.

## 3. Identity, login and token refresh

### 3.1 Identity model

The server derives an identity from the token's `(iss, sub)` pair. The same user logging in again through the same IdP gets the same identity; this is verified. A new identity has **no access** until an OWNER calls `invite_member(organizationId, identity, role)`. The 2.14.1 SDK has no helper that computes an identity from claims, so enrollment works like this:

1. The user signs in once and connects.
2. The UI displays `identity.toHexString()` from `onConnect`, and the user calls `register_profile` so they appear by name.
3. The OWNER pastes that identity into the invite form.

### 3.2 Two modes, reported by `backend_info.issuerPolicyEnforced`

| Mode | When | Who can connect |
|---|---|---|
| **OPEN** (development only) | `trusted_issuer` is empty | any token the host accepts, including server-minted tokens from `POST /v1/identity`. Anyone who can reach the host can mint one. Use OPEN mode only on a local machine or an isolated demo network |
| **ENFORCED** | a platform admin has added at least one issuer | **people:** an OIDC token from a trusted issuer, with an `aud` value in that issuer's audience list (if the list is non-empty), an `exp`, and a lifetime (`exp - iat`) of at most 24 h. **Machines:** platform admins and active service principals connect with their enrolled server-minted tokens |

How the host and the module divide the checks (all verified by `oidcLogin.test.ts`):

- **The host** fetches the issuer's OIDC discovery document and JWKS and verifies RS256 signatures. Bad signatures and expired tokens get **HTTP 401** before the module runs.
- **The module's `onConnect`** enforces the issuer, audience, expiry and lifetime rules above. A rejected HTTP call gets **HTTP 403** with the body `AUTH_REQUIRED: <reason>`. A rejected WebSocket connection fails in `onConnectError`.

The exact rejection reasons are:

- `a token from a trusted issuer is required`
- `token issuer is not trusted`
- `token audience is not accepted`
- `token must carry an expiry (exp)`
- `token has expired`
- `token lifetime exceeds 86400 seconds`
- `account disabled`

Enforcement setup (platform admin):

```ts
await admin.conn.reducers.addTrustedIssuer({ issuer: 'https://login.example-idp.test/realms/sentinelzero' });
await admin.conn.reducers.addTrustedAudience({ issuer: 'https://login.example-idp.test/realms/sentinelzero', audience: 'sentinelzero-web' });
```

### 3.3 Browser login and refresh

1. Sign in with the chosen OIDC provider (authorization code flow with PKCE) and take the **ID token**. It must carry `iss`, `sub`, `aud` (the configured client ID), `iat` and an `exp` no more than 24 h after `iat`.
2. Call `withToken(idToken)` and connect.
3. **Refresh.** An open WebSocket session is not cut off when the ID token expires, because the token is checked only at connect time. When the IdP issues a fresh ID token, call `conn.disconnect()` and reconnect with the new token. Reconnect immediately after any `onConnectError` or disconnect. Revocation does **not** depend on refresh: revoking a membership or disabling a user takes effect on open sessions immediately.
4. **Storage.** In ENFORCED mode, keep the ID token where your OIDC library keeps it and do not persist the `token` passed to `onConnect`. In OPEN mode only, persisting that token (for example in `localStorage`) keeps the same development identity across reloads.

### 3.4 What the SDK sends on the wire (verified on 2.14.1)

1. The SDK POSTs the user's token in an `Authorization` header to `/v1/identity/websocket-token`.
2. The host returns a host-signed token. It keeps `iss`, `sub` and `aud` but has a fresh `iat` and `exp = now + 60 s`.
3. The SDK opens the WebSocket with `?token=<short-lived token>`.

Consequences:

- **The IdP token never appears in a URL.** Only the 60-second host token does. Reverse proxies and load balancers in front of SpacetimeDB **must not log query strings**.
- **Issuer and audience checks apply on every path. Expiry and lifetime checks apply to HTTP calls only.** On the WebSocket path the module sees the re-issued token. A non-expired IdP token without `exp`, or with an over-long lifetime, can therefore still open a socket. The tests pin this limitation. The mitigation is to configure the IdP to always issue `exp` with a short lifetime. See `docs/SECURITY_MODEL.md`.

## 4. Approvals, recommendations and audit

### 4.1 Human-in-the-loop data model

- The AI can only **insert PENDING `recommendation` rows**, through `agent_submit_recommendation`. It has no membership, no access to views or tables, and no other reducers. The tests try `approve_recommendation`, `transition_incident_status`, the human views and raw SQL with a service-principal token, and all of them are denied.
- A human OWNER or COMMANDER calls `approve_recommendation` or `reject_recommendation`. Approval is atomic and idempotent. In a single transaction it:
  1. checks the role and the recommendation's status;
  2. sets the recommendation to APPROVED;
  3. creates **one** task with idempotency key `rec:<recommendationId>`;
  4. appends **one** audit event.

  Concurrent approvals from two commanders produce one task and one audit event (`negativeSecurity.test.ts`). The `createdTaskId` field on the recommendation links to the task.
- Tasks that require approval (`requiresApproval = true`) use `approve_task` and `reject_task` under the same rules.

`Recommendation` row: `{id, organizationId, incidentId, agentRunId, title, description, priority, rationale, evidenceIds[], uncertainties[], inferenceMode, modelIdentifier, status, createdTaskId, decidedBy?, decidedAt?, decisionReason, createdAt, dedupeKey}`.

### 4.2 Audit chain: tamper-evident, **not immutable**

Every write appends an `audit_event` row to a per-organization SHA-256 hash chain:

```
hash = sha256_hex(join('\n', [organizationId, incidentId, seq, actorHex, actorKind, eventType, targetId, timestampMicros, metadata, previousHash]))
```

The first event links to `AUDIT_GENESIS_HASH`. The canonical code is `computeAuditHash` in `packages/shared/src/auditChain.ts`, which the module also uses.

```ts
import { verifyAuditChain } from '<repo>/packages/shared/src/auditChain';
const head = [...conn.db.myAuditChainHeads.iter()].find(h => h.organizationId === orgId);
const result = verifyAuditChain(orgId, conn.db.myAuditEvents.iter(), { head, pin: lastPinnedOrUndefined });
// result.status: 'VERIFIED' | 'BROKEN' | 'EMPTY'
// result.failure?: {reason, seq, eventId, detail}, where reason is one of GENESIS_MISMATCH, SEQ_GAP, DUPLICATE_SEQ,
//                  LINK_MISMATCH, HASH_MISMATCH, HEAD_MISMATCH, PIN_MISMATCH
// After VERIFIED, store {seq: result.lastSeq, hash: result.lastHash} as the next pin.
```

Show these labels honestly:

| Result | Label |
|---|---|
| `VERIFIED` with `headChecked` | "Chain verified against server head (N events)" |
| `VERIFIED` with `pinChecked` | also "consistent with your last check" |
| `BROKEN` | "Audit chain verification FAILED at seq X (reason)" |
| `EMPTY` | "No audit events" |

What verification detects:

- an edited, reordered, inserted or deleted event;
- truncation, but only when `head` is supplied;
- a full rewrite of the chain by someone who controls the database, but only against a `pin` the client stored earlier.

It does **not** prevent changes, and there is no external anchoring yet. Never call the chain "immutable".

## 5. AI service integration (OpenCode)

### 5.1 Service principal: the scoped access mechanism

1. Mint a dedicated identity with `POST {STDB_URI}/v1/identity`, which returns `{identity, token}`. Store the token as a secret in `AI_BACKEND_SERVICE_TOKEN`. Never log it or commit it.
2. An OWNER calls `register_service_principal({organizationId, identity, label: 'sentinelzero-ai'})`. A service principal is bound to **one organization** and has **no** human membership.
3. To revoke it, an OWNER calls `revoke_service_principal`. All tool calls fail immediately afterwards.

### 5.2 Flow

```
Browser                                        AI service (FastAPI)                     SpacetimeDB
  │ conn.reducers.requestAgentRun({incidentId, analysisType, idempotencyKey})  ───────────────▶ run REQUESTED
  │ wait for the row in my_agent_runs → runId
  │ POST <AI route> {incident_id, run_id, analysis_type}   (Authorization: Bearer <user's ID token>)
  │ ─────────────────────────────────────────▶ │ verify_agent_run_access [runId]  (USER token) ─▶ RunAccess
  │                                            │ require authorized && isRequester && status=="REQUESTED"
  │                                            │         && incidentId == request.incident_id
  │                                            │ agent_claim_run, agent_get_*, agent_submit_recommendation,
  │                                            │ agent_complete_run              (SERVICE token) ─▶ PENDING recommendations
  │ my_recommendations / my_agent_runs update live ◀────────────────────────────────────────────
  │ approve_recommendation (human, OWNER/COMMANDER) ──────────────────────────────────────────▶ one task + audit
```

The browser's request body is the `AiAnalyzeRequest` Zod schema in `packages/shared/src/schemas.ts` (`{incident_id, run_id, analysis_type}`, strict). The AI service owns its own route path. The `run_id` **must** be the SpacetimeDB run ID; the AI service must not mint its own.

### 5.3 SpacetimeDB HTTP calls (wire format)

Every call is `POST {STDB_URI}/v1/database/{DB}/call/{name}` with the headers `Authorization: Bearer <token>` and `Content-Type: application/json`. The body is a positional JSON array.

| Step | Call | Token | Body | Success response |
|---|---|---|---|---|
| 1 | `verify_agent_run_access` (procedure) | **the user's** token, forwarded and never logged | `[runId]` | 200 `[authorized, isRequester, role, runId, incidentId, organizationId, status]`. When not authorized, `authorized=false` and the other fields are blank |
| 2 | `agent_claim_run` (reducer) | service | `[runId, modelIdentifier, inferenceMode]` | 200. The run becomes RUNNING with a 15-minute lease. `inferenceMode` is `LIVE`, `SIMULATED` or `FIXTURE` |
| 3 | `agent_get_incident`, `agent_get_assets`, `agent_get_dependencies`, `agent_get_open_tasks`, `agent_get_evidence_summaries` (procedures) | service | `[runId]` | 200 `[0, value]`, or `[1, "CODE: detail"]` on denial. Value shapes are in `AGENT_PROCEDURE_FIELDS` |
| 4 | `agent_submit_recommendation` (reducer) | service | `[runId, clientKey, title, description, priority (P1..P4), rationale, evidenceIds[], uncertainties[]]` | 200. Creates a **PENDING** recommendation, deduplicated by `clientKey`, at most 10 per run. `evidenceIds` must belong to the run's incident |
| 5 | `agent_complete_run` (reducer) | service | `[runId, 'COMPLETED'\|'FAILED', errorCategory, summary]` | 200. COMPLETED requires `errorCategory = 'NONE'` |

How to handle responses:

| Response | Meaning | Action |
|---|---|---|
| 200 from `agent_get_*` | result envelope | decode it with `decodeResult`; a `[1, …]` envelope means stop the run |
| 530 | typed reducer error, body `"CODE: detail"` | handle by code |
| 403 with `AUTH_REQUIRED: …` | issuer policy rejected the token | for the user's token, return 401 to the browser |
| 401 | the host rejected the token (expired or bad signature) | same as above |
| 400 | malformed arguments: a client bug | log the function name only |
| any other non-2xx | | `SERVICE_UNAVAILABLE`; mark the run FAILED and never fabricate data |

Encoding rules: identity arguments are `["0x<64 hex>"]`, and option arguments are `{"some": v}` or `{"none": []}`.

Every tool call re-checks all of the following and records an `agent_tool_call` row:

- the service principal is active for the run's organization;
- the run is RUNNING, claimed by this principal and within its lease;
- the requester **still** has `REQUEST_AGENT_RUN`.

Example call:

```bash
curl -sS -X POST "$STDB_URI/v1/database/$STDB_DB_NAME/call/agent_get_incident" \
  -H "Authorization: Bearer $AI_BACKEND_SERVICE_TOKEN" -H "Content-Type: application/json" -d '["<runId>"]'
```

### 5.4 Rules the AI service must follow

- **Authorize only through `verify_agent_run_access`.** Never authorize from `org_id` or `roles` claims in a JWT. Those claims are not issued or checked by SpacetimeDB.
- **There are no `/internal/v1/...` routes.** The only backend API is the SpacetimeDB HTTP API above.
- **Map inference labels to `inferenceMode`.** `LIVE` means genuine NVIDIA inference only. Anything simulated or from fixtures must be `SIMULATED` or `FIXTURE`.
- **Nothing the AI service does is an approval.** It never calls human reducers. A human must approve every task.

## 6. Environment variables

The root `.env.example` lists every variable as a placeholder. Real values go in an untracked `.env` file or a secret store.

| Variable | Used by | Meaning |
|---|---|---|
| `STDB_URI`, `STDB_DB_NAME` | AI service, scripts | SpacetimeDB base URL and database name |
| `VITE_STDB_URI`, `VITE_STDB_DB_NAME` | web | the same values, exposed to the browser |
| `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID` | web | the IdP; the client ID is the trusted audience |
| `AI_BACKEND_MODE=http`, `AI_BACKEND_BASE_URL` | AI service | existing `services/ai` settings; the base URL is the SpacetimeDB host. The AI service also needs the database name; OpenCode chooses that variable's name |
| `AI_BACKEND_SERVICE_TOKEN` | AI service | the service-principal token (**secret**) |
| `AI_NVIDIA_API_KEY` | AI service | NVIDIA API key (**secret**) |
| `SZ_STDB_URI`, `SZ_DB`, `SZ_ADMIN_TOKEN`, `SPACETIME_CLI` | tests and scripts | local tooling; `SZ_ADMIN_TOKEN` is **secret** |

## 7. Local setup and demo accounts

```powershell
npm run setup                       # from the repo root: installs packages/shared and packages/spacetime (npm ci)
$env:SPACETIME_CLI = "$env:LOCALAPPDATA\SpacetimeDB-2.14.1\spacetimedb-cli.exe"
& $env:SPACETIME_CLI start --listen-addr 127.0.0.1:3000 --in-memory `
    --jwt-pub-key-path <dir>\id_ecdsa.pub --jwt-priv-key-path <dir>\id_ecdsa   # ES256 dev keys, never committed
npm run build                       # builds packages/spacetime/dist/bundle.js
npm run seed:demo                   # publishes to SZ_DB (default sentinelzero) and seeds the demo
```

`seed:demo` runs `packages/spacetime/scripts/seed-demo.mjs --publish`. It creates:

- one organization named `EXERCISE Regional Hospital <date>` with `dataClass = EXERCISE`;
- one account per role (OWNER, COMMANDER, ANALYST, RESPONDER, OBSERVER), each with a registered profile;
- a registered AI service principal;
- one synthetic incident.

It prints only identities. The tokens are written to `packages/spacetime/.demo/demo-accounts.json`, which is git-ignored. These tokens are local, OPEN-mode development credentials. Never paste them into chats, issues or commits.

## 8. Handoffs

**Antigravity (web, `apps/web`)**

1. Replace the mock in `apps/web/src/services/spacetimeClient.ts` with the generated `DbConnection` (section 2). Its current `connectToLiveBackend` opens `new WebSocket(\`${url}?token=…\`)`. That **violates this contract**: it puts the long-lived token in the URL and does not use the SpacetimeDB protocol. Delete it.
2. Use the bindings from `packages/spacetime/bindings` and the helpers from `packages/shared/src`, including `roleHas`, `buildImpactGraph`, `parseBackendError`, `verifyAuditChain` and the enums. Use `roleHas` only to hide controls; the server enforces every capability.
3. On startup, check `backend_info.contractVersion`. Show `dataClass` on incident screens and `inferenceMode` on every AI artifact. Render all user and AI text as plain text.
4. For the audit panel, use section 4.2 and its labels. For OBSERVER, read only `my_incident_summaries`; it gets no detail views.

**OpenCode (AI service, `services/ai`)**

1. `HttpBackendClient` targets `/internal/v1/...` with an `X-Sentinel-Service-Token` header. **Those routes do not exist.** Replace them with the calls in section 5.3.
2. `auth.py` trusts JWT `org_id` and `roles` claims. Replace that with `verify_agent_run_access` using the forwarded user token.
3. `POST /v1/incidents/{id}/analyze` mints its own `run_<hex>` IDs. Accept the browser's SpacetimeDB `run_id` instead, and claim that run.
4. Map `inference_label` to `inferenceMode` and submit proposals only through `agent_submit_recommendation`. Read results back from SpacetimeDB.
