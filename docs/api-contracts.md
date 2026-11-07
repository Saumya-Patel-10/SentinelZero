# SentinelZero API Contracts (v1, FROZEN)

Owner: AGENT-1 (backend and security). Status: **frozen** on branch `agent/01-backend-security`.
Changing anything in this document requires a new contract version and a note to AGENT-2 and AGENT-3.

The source of truth is the code. If this document disagrees with the code, the code wins; report the drift.

| Contract | Source of truth |
|---|---|
| Tables, reducers, procedures, views | `packages/spacetime/src/**` |
| Generated TypeScript client | `packages/spacetime/bindings/**` (generated, committed) |
| Enums, limits, role matrix, state machines, graph transform | `packages/shared/src/*.ts` |
| Browser ↔ FastAPI schemas (Zod) | `packages/shared/src/schemas.ts` |
| FastAPI ↔ SpacetimeDB HTTP wire format | `packages/shared/src/agentContracts.ts` |
| Error codes | `packages/shared/src/errors.ts` |

## 1. Pinned versions

| Component | Version |
|---|---|
| SpacetimeDB CLI and standalone server | **2.14.1** (CLI commit `a0bf6be`) |
| `spacetimedb` npm package (server module and client SDK) | **2.14.1** (exact) |
| `@noble/hashes` (audit hash chain) | 2.4.0 |
| `zod` (shared schemas) | 4.6.7 |
| TypeScript / Vitest / @types/node | 5.6.3 / 3.2.4 / 24.10.1 |
| Node.js | >= 20 (verified on 24.x) |

The module is written in TypeScript and imports only from `spacetimedb/server`. Every API it uses was verified against the installed 2.14.1 typings and the running 2.14.1 server.

## 2. Local setup (Windows PowerShell; the same flags work on other platforms)

```powershell
# 0. Corporate TLS proxies: let npm/node use the OS certificate store.
$env:NODE_OPTIONS = "--use-system-ca"

# 1. CLI. On this machine the 2.14.1 binaries live here (any 2.14.1 install works):
$env:SPACETIME_CLI = "$env:LOCALAPPDATA\SpacetimeDB-2.14.1\spacetimedb-cli.exe"

# 2. Start a local server. The standalone server needs an ES256 key pair to mint identities.
#    Generate one once (never commit it):
#      node -e "const c=require('crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256'});require('fs').writeFileSync('id_ecdsa.pub',k.publicKey.export({type:'spki',format:'pem'}));require('fs').writeFileSync('id_ecdsa',k.privateKey.export({type:'pkcs8',format:'pem'}))"
& $env:SPACETIME_CLI start --listen-addr 127.0.0.1:3000 --in-memory `
    --jwt-pub-key-path <dir>\id_ecdsa.pub --jwt-priv-key-path <dir>\id_ecdsa

# 3. Install, build, publish, generate
cd packages\shared;    npm install
cd ..\spacetime;       npm install
& $env:SPACETIME_CLI build --module-path .
& $env:SPACETIME_CLI publish --server local --module-path . sentinelzero --delete-data --yes
& $env:SPACETIME_CLI generate --lang typescript --out-dir ./bindings --module-path . --yes
```

If `spacetime` is on `PATH`, the npm scripts wrap the same commands: `npm run build`, `npm run publish:local`, `npm run generate`.

**Platform admin.** The `init` reducer makes the identity that **published** the database a platform admin. Only a platform admin can create organizations, manage trusted issuers and disable users. For scripted seeding, publish over HTTP using a dedicated identity, as `tests/integration/globalSetup.ts` does:

1. Call `POST /v1/identity` to get `{identity, token}`.
2. Call `PUT /v1/database/<name>?host_type=Js` with `Authorization: Bearer <token>` and the body `dist/bundle.js`.

Keep that token in a secret store or an environment variable. Never commit or log it.

## 3. Tests (exact commands)

```powershell
cd packages\spacetime
$env:SPACETIME_CLI = "$env:LOCALAPPDATA\SpacetimeDB-2.14.1\spacetimedb-cli.exe"
.\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json          # module typecheck
.\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.test.json     # tests + bindings typecheck
.\node_modules\.bin\vitest.cmd run --config vitest.config.ts               # unit (no server)
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts   # integration (server on :3000)
```

The integration setup builds the module and publishes it under a unique throwaway name (`sentinelzero-test-<time>`) using a freshly minted identity. It deletes that database on teardown. Overrides:

| Variable | Default |
|---|---|
| `SZ_STDB_URI` | `http://127.0.0.1:3000` |
| `SZ_TEST_DB` | unique per run |
| `SPACETIME_CLI` | `spacetime` |

## 4. Identity and session contract

- **Identity** is SpacetimeDB's `ctx.sender`, which the server derives from the connection's JWT. Reducers **never** accept an actor, role, user ID or organization membership from the request body. Server code sets every actor field (`createdBy`, `senderIdentity`, `grantedBy`, `approvedBy`, `decidedBy`, `requestedBy`, audit `actorIdentity`).
- **Browser**: connect with the generated `DbConnection`, then persist the returned token, for example in `localStorage`:
  ```ts
  import { DbConnection } from '<path>/packages/spacetime/bindings';
  DbConnection.builder()
    .withUri(import.meta.env.VITE_STDB_URI)        // e.g. ws://127.0.0.1:3000
    .withDatabaseName('sentinelzero')
    .withToken(localStorage.getItem('sz_token') ?? undefined)
    .onConnect((conn, identity, token) => { localStorage.setItem('sz_token', token); /* subscribe */ })
    .onConnectError((_ctx, err) => { /* show "backend unavailable" */ })
    .build();
  ```
  A new identity has **no access** until an OWNER calls `invite_member` for it. It should call `register_profile(displayName)` so that it appears by name in `org_member_directory`.
- **Trusted issuers (optional hardening).** While `trusted_issuer` is empty, any identity the server issues may connect. Once a platform admin adds at least one issuer, `onConnect` rejects tokens from any other issuer (`AUTH_REQUIRED`) over both WebSocket and HTTP. This is verified by `issuerPolicy.test.ts`.
- **Disabled users.** `set_user_disabled` (platform admin only) removes all access everywhere while preserving memberships for audit.

## 5. Subscriptions (read API)

All base tables are **private**. Clients can only read the per-sender views below. Each view re-checks the caller's active membership and role every time it is evaluated. Subscribe with plain `SELECT * FROM <view>` and filter by `incidentId` on the client:

```ts
conn.subscriptionBuilder()
  .onApplied(() => { /* initial snapshot ready */ })
  .onError(ctx => { /* show error state */ })
  .subscribe(['SELECT * FROM my_incidents', 'SELECT * FROM my_tasks', /* ... */]);

conn.db.myIncidents.onInsert((_ctx, row) => ...);   // also onUpdate / onDelete where rows have a primary key
const tasks = [...conn.db.myTasks.iter()].filter(t => t.incidentId === selectedId);
```

The full list is exported as `ALL_VIEWS` in `tests/integration/fixtures.ts`. Subscribing to a private table such as `SELECT * FROM incident` fails with a subscription error. HTTP SQL against one returns 400.

The Role column lists who sees rows: O = OWNER, C = COMMANDER, A = ANALYST, R = RESPONDER, Ob = OBSERVER. Roles not listed get zero rows.

| View | Row type | Role | Notes |
|---|---|---|---|
| `my_profile` | `UserProfile` (option) | any | own profile |
| `my_memberships` | `Membership` | any | own memberships, **including revoked** ones, so the UI can show "access revoked" |
| `my_organizations` | `Organization` | O C A R Ob | active memberships only |
| `org_member_directory` | `MemberDirectoryEntry {membershipId, organizationId, userIdentity, displayName, role}` | O C A R | active members, for assignment pickers |
| `my_incident_summaries` | `IncidentSummary {id, organizationId, title, category, severity, status, dataClass, reportedAt, updatedAt}` | O C A R Ob | the only incident data OBSERVER sees |
| `my_incidents` | `Incident` | O C A R | full detail including `version` (needed for updates) |
| `my_assets`, `my_services`, `my_service_dependencies`, `my_operational_impacts` | graph rows | O C A R | input to `buildImpactGraph` |
| `my_data_scopes` | `DataScope` | O C A | sensitive data scope |
| `my_evidence` | `EvidenceReference` | O C A | metadata and hash only, never file contents |
| `my_tasks` | `Task` | O C A R | |
| `my_messages` | `Message` | O C A R | message text is **untrusted** user input; render as text, never as HTML |
| `my_agent_runs`, `my_agent_tool_calls`, `my_recommendations` | AI activity | O C A | `inferenceMode` is LIVE, SIMULATED or FIXTURE and **must** be shown |
| `my_audit_events` | `AuditEvent` | O C A | sort by `seq`; hash-chained |
| `my_service_principals` | `ServicePrincipal` | O | |

**Revocation of live subscriptions (verified).** When a membership is revoked or a user is disabled, the views are re-evaluated. The affected rows are **deleted from the client cache of existing subscriptions** and `onDelete` fires. No reconnect is needed. New subscriptions and HTTP SQL return zero rows, and writes fail. See `revocation.test.ts`.

**Graph.** Feed `my_assets`, `my_services`, `my_service_dependencies` and `my_operational_impacts` into `buildImpactGraph(incidentId, {...})` from `packages/shared/src/graph.ts`. It returns `{nodes: GraphNode[], edges: GraphEdge[]}`, ready for React Flow:

- Node `kind` is `asset`, `service` or `impact_group`; edge `kind` is `dependency` or `impact`.
- Edges pointing at missing nodes are dropped.
- Impact groups come **only** from explicit `operational_impact` rows, never from inference.

## 6. Reducers (write API)

Clients call reducers with `conn.reducers.<camelName>({...})`. Each call returns `Promise<void>`. The promise resolves once the transaction commits and rejects with an `Error` whose message is `"<CODE>: <detail>"`; parse it with `parseBackendError(e.message)`. Over HTTP, use `POST /v1/database/<db>/call/<snake_name>` with either a named-object or a positional-array JSON body:

- Success returns **200** with an empty body.
- Failure returns **530** with the body `"<CODE>: <detail>"`.
- Encode an `option` argument as `{"some": v}` or `{"none": []}`.
- Encode an `identity` argument as a **one-element array** holding a `0x`-prefixed hex string, for example `{"some": ["0xc200…"]}`. A bare hex string is rejected with HTTP 400. This is verified by `httpEncoding.test.ts`.
- A malformed body (wrong types or arity) returns **400** with a plain-text message, not a typed code.

Conventions:

- `expectedVersion` is optimistic concurrency. Pass the `version` you displayed; a stale value fails with `VERSION_CONFLICT`. On success the version increments by 1.
- `idempotencyKey` and `clientKey` are 8-128 characters matching `[A-Za-z0-9._:-]`. Retrying with the same key is a no-op that returns success.
- Text fields reject control characters, bidi overrides and blank-only values. HTML is stored **verbatim** as text, so escape it on render.
- Pass `''` for "not provided" in optional string arguments such as `evidenceId` and `reason`, unless the reducer requires the value.
- Writes to child records of a **CLOSED** incident fail with `INVALID_TRANSITION`.

### Platform and organization

| Reducer | Arguments | Who |
|---|---|---|
| `add_trusted_issuer` / `remove_trusted_issuer` | `issuer: string` | platform admin |
| `create_organization` | `name, dataClass: EXERCISE\|LIVE` | platform admin (becomes OWNER) |
| `set_user_disabled` | `userIdentity: Identity, disabled: bool` | platform admin |
| `register_profile` | `displayName` | any identity |
| `invite_member` | `organizationId, userIdentity, role` | OWNER |
| `revoke_member` | `membershipId, reason` | OWNER (idempotent; cannot remove the last OWNER) |
| `register_service_principal` | `organizationId, identity, label` | OWNER (identity must not be a human member or a platform admin) |
| `revoke_service_principal` | `servicePrincipalId` | OWNER |

### Incidents

| Reducer | Arguments | Who |
|---|---|---|
| `create_incident` | `organizationId, title, description, category, severity, detectedAt: Timestamp?, idempotencyKey` | O C A |
| `update_incident` | `incidentId, expectedVersion, title, description, category, severity` | O C A |
| `transition_incident_status` | `incidentId, expectedVersion, toStatus, reason, evidenceId` | O C. Reopening (RESOLVED or CLOSED → INVESTIGATING) is COMMANDER only and needs a reason of at least 10 characters |
| `assign_incident_commander` | `incidentId, expectedVersion, commanderIdentity` | O C. The target must be an active COMMANDER |

### Impact graph and data scope

| Reducer | Arguments | Who |
|---|---|---|
| `add_asset` | `incidentId, name, assetType, criticality, compromiseStatus, availabilityStatus, description` | O C A |
| `update_asset_status` | `assetId, expectedVersion, compromiseStatus, availabilityStatus, verifiedNow, reason` | O C A |
| `add_service` | `incidentId, name, description, criticality, availabilityStatus, availabilityVerification` | O C A |
| `update_service_status` | `serviceId, expectedVersion, availabilityStatus, availabilityVerification, reason` | O C A |
| `add_service_dependency` | `incidentId, sourceAssetId, targetServiceId, dependencyType, verification` | O C A (deduplicated) |
| `update_dependency_verification` | `dependencyId, verification, reason` | O C A |
| `add_operational_impact` | `incidentId, serviceId, impactType, severity, verification, affectedGroup, description` | O C A |
| `update_operational_impact` | `impactId, expectedVersion, severity, verification, description` | O C A |
| `update_data_scope` | `incidentId, assetId, dataCategory, sensitivity, lockStatus, exfiltrationStatus, integrityStatus, estimatedRecords: u64?, confidence, evidenceId` | O C A. Upserts by (incident, asset, category); `expectedVersion` is not needed |

### Tasks, messages, evidence

| Reducer | Arguments | Who |
|---|---|---|
| `create_task` | `incidentId, title, description, priority, assignedIdentity?, requiresApproval, idempotencyKey` | O C A. `requiresApproval` sets the status to AWAITING_APPROVAL |
| `assign_task` | `taskId, expectedVersion, assignedIdentity?` | O C A. The assignee must be active and not OBSERVER |
| `update_task_status` | `taskId, expectedVersion, toStatus, note` | the assignee, or O C A. CANCELLED requires O C A |
| `approve_task` / `reject_task` | `taskId, reason` | O C. Repeating the same decision is a no-op; a contradictory decision fails with `INVALID_TRANSITION` |
| `send_message` | `incidentId, content, clientMessageId` | O C A R. Deduplicated by `clientMessageId`; limited to 30 per 60 s |
| `append_evidence_reference` | `incidentId, evidenceType, source, sha256 (64 lowercase hex), classification, description` | O C A. Append-only |

### AI (human side)

| Reducer | Arguments | Who |
|---|---|---|
| `request_agent_run` | `incidentId, analysisType: intake\|impact\|response, idempotencyKey` | O C A. Limited to 5 per 60 s |
| `cancel_agent_run` | `runId, reason` | the requester, or O C |
| `approve_recommendation` | `recommendationId, assignedIdentity?, reason` | O C. Creates **exactly one** task (`idempotencyKey = rec:<id>`, `source = AI_RECOMMENDATION`), even under concurrent or repeated calls |
| `reject_recommendation` | `recommendationId, reason` | O C |

## 7. State machines (from `packages/shared/src`)

**Incident** (`incidentLifecycle.ts`):

```
REPORTED      -> TRIAGING | CLOSED
TRIAGING      -> INVESTIGATING | CLOSED
INVESTIGATING -> CONTAINING | RESOLVED
CONTAINING    -> CONTAINED | INVESTIGATING
CONTAINED     -> RECOVERING | CONTAINING
RECOVERING    -> RESOLVED | CONTAINING
RESOLVED      -> CLOSED
reopen: RESOLVED | CLOSED -> INVESTIGATING  (COMMANDER, reason >= 10 chars)
```

**Task** (`taskLifecycle.ts`):

```
AWAITING_APPROVAL -> (approve) PENDING | (reject) CANCELLED
PENDING     -> IN_PROGRESS | BLOCKED | CANCELLED
IN_PROGRESS -> BLOCKED | COMPLETED | CANCELLED
BLOCKED     -> IN_PROGRESS | CANCELLED
COMPLETED, CANCELLED: terminal
```

**Agent run**: REQUESTED → RUNNING (claimed; 15-minute lease) → COMPLETED or FAILED. A run can be CANCELLED from REQUESTED or RUNNING. The scheduled sweep moves REQUESTED runs older than 10 minutes, and RUNNING runs past their lease, to EXPIRED.

**Recommendation**: PENDING → APPROVED (creates a task) or REJECTED.

## 8. Errors

The format is `"<CODE>: <detail>"`. The detail is safe to show to users and never contains secrets or data from another tenant.

| Code | Meaning | UI behaviour |
|---|---|---|
| `AUTH_REQUIRED` | token issuer is not on the trusted-issuer allowlist (connection rejected) | prompt sign-in with an approved identity provider |
| `ACCESS_DENIED` | member of the organization, but the role lacks the capability (or the caller is not a member, for organization-level calls) | show "not permitted" |
| `INCIDENT_NOT_FOUND` | the incident does not exist **or** the caller cannot see it (deliberately indistinguishable) | show "not found" |
| `NOT_FOUND` | other referenced record missing | |
| `INVALID_TRANSITION` | state machine violation, a CLOSED incident, or a conflicting decision | refresh the view |
| `VALIDATION_FAILED` | bad input (enum, length, characters, format) | show field error |
| `VERSION_CONFLICT` | stale `expectedVersion` | reload the row and retry |
| `RATE_LIMITED` | too many requests | back off |
| `SERVICE_UNAVAILABLE` | client-side mapping for network errors or any untyped non-2xx response | retry later |

## 9. AI service (FastAPI) contract

### 9.1 Browser → FastAPI (`packages/shared/src/schemas.ts`)

```
POST /api/ai/analyze
Authorization: Bearer <the user's SpacetimeDB token>
{ "incident_id": "...", "run_id": "...", "analysis_type": "intake" | "impact" | "response" }   (strict)
```

**Change from the THREE_AGENT_PLAN draft, made deliberately:** the request now requires `run_id`. The browser must first call `request_agent_run` so that the requester is the identity verified by SpacetimeDB, then read the run ID from `my_agent_runs`, then call FastAPI.

The response (`AiAnalyzeResponse`) has these fields:

- `run_id`
- `status`: pending, running, completed, failed or cancelled
- `inference_mode`: LIVE, SIMULATED or FIXTURE
- `model_identifier`
- `verified_facts[]`: each fact needs at least one evidence ID
- `uncertainties[]`
- `proposed_actions[]`: each action needs evidence IDs **or** uncertainties; at most 10
- `error_category?`

The authoritative copy of proposals is `my_recommendations`. The HTTP response is a convenience.

### 9.2 FastAPI → SpacetimeDB (`packages/shared/src/agentContracts.ts`)

FastAPI holds **one service-principal token**: an identity that an OWNER registered with `register_service_principal`. It is stored in a secret store, such as the `STDB_SERVICE_TOKEN` environment variable, and is never logged. The service principal has **no** human membership. It cannot read views, private tables, or any reducer outside the list below.

| Step | Call | Token | Body (positional or named) | Success |
|---|---|---|---|---|
| 1 | `verify_agent_run_access` (procedure) | **user's** token from the browser request | `[runId]` | 200 `RunAccess` positional `[authorized, isRequester, role, runId, incidentId, organizationId, status]`. If unauthorized, `authorized=false` and the other fields are blank. Reject unless `authorized && incidentId == request.incident_id && status == "REQUESTED"` |
| 2 | `agent_claim_run` (reducer) | service | `[runId, modelIdentifier, inferenceMode]` | 200; the run becomes RUNNING with a 15-minute lease |
| 3 | `agent_get_incident`, `agent_get_assets`, `agent_get_dependencies`, `agent_get_open_tasks`, `agent_get_evidence_summaries` (procedures) | service | `[runId]` | 200 with `[0, value]`, or `[1, "CODE: detail"]` when denied |
| 4 | `agent_submit_recommendation` (reducer) | service | `[runId, clientKey, title, description, priority, rationale, evidenceIds[], uncertainties[]]` | 200; creates a PENDING recommendation (deduplicated by `clientKey`; at most 10 per run) |
| 5 | `agent_complete_run` (reducer) | service | `[runId, status: COMPLETED\|FAILED, errorCategory, summary]` | 200. COMPLETED requires `errorCategory = NONE` |

Every tool call checks all of the following, then writes a row to `agent_tool_call`:

- the service principal is active for the organization;
- the run is RUNNING, claimed by the caller, and within its lease;
- the requester **still** has `REQUEST_AGENT_RUN`, so revoking the requester stops the run.

Procedure values are positional arrays in the field order of `AGENT_PROCEDURE_FIELDS`. All scalar fields are strings or booleans, and `''` means unknown or absent. Timestamps are ISO-8601 strings. `estimatedRecords` is a decimal string. `AgentTask.assigned` is a boolean; the assignee's identity is deliberately withheld. Port `decodeResult` and `decodePositional` to Python as written.

Response handling for FastAPI:

- **200** from `agent_get_*`: decode the envelope. `[1, ...]` is a typed denial, so stop the run.
- **530**: a typed reducer error in the body.
- **400**: malformed arguments. This is a bug in FastAPI; log the function name only, never the body or token.
- **Any other non-2xx, including 500**: treat as `SERVICE_UNAVAILABLE`, mark the run FAILED, and never fabricate data.

The AI service **cannot** approve, create tasks, change incident state, or read messages, because it has no membership and no tool exposes messages. The tests attempt `approve_recommendation`, `transition_incident_status`, the human views and raw table SQL with the service token. The reducers return `INCIDENT_NOT_FOUND`, and the views and SQL return no rows.

## 10. Integration steps

**AGENT-2 (web, `apps/web`)**

1. Import the bindings from `packages/spacetime/bindings` (or copy them into the app at build time). Import enums, `buildImpactGraph`, `parseBackendError`, `roleHas` and the state machines from `packages/shared/src`. Never redefine enum literals.
2. Use `roleHas(role, capability)` only to **hide** controls. The server enforces every capability regardless.
3. Show `dataClass` (EXERCISE or LIVE) on every incident screen, and `inferenceMode` on every AI artifact.
4. Render all user and AI text as plain text.
5. To start an AI run: call `request_agent_run`, wait for the run in `my_agent_runs`, then `POST /api/ai/analyze` with `{incident_id, run_id, analysis_type}` and the user's token.

**AGENT-3 (AI service, simulator, e2e)**

1. Provision the service principal: mint an identity (`POST /v1/identity`), store the token as a secret, and have the OWNER call `register_service_principal(orgId, identity, "sentinelzero-ai")`.
2. Implement the HTTP calls in section 9.2 exactly. A typed Python model per `AGENT_PROCEDURE_FIELDS` record is recommended.
3. **Simulator seed contract**: there is no seed reducer. A platform-admin token (from the HTTP publish described in section 2) runs `create_organization` and then `invite_member` for the simulator's OWNER identity. The simulator then creates incidents, assets, services, dependencies, impacts, data scopes and evidence through the reducers above, as any analyst would. Use `dataClass = EXERCISE` and label simulated content.
4. E2E tests can reuse `tests/integration/client.ts` patterns: mint fresh identities per role and subscribe to the views.
