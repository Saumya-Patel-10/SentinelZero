# SentinelZero Security Model

Contract version 1.1.0 (see `docs/INTEGRATION_CONTRACT.md`). Scope: the SpacetimeDB backend, its identity and issuer policy, and the trust boundaries with the web client and the AI service. `docs/threat-model.md` keeps the per-threat table. This document is the authoritative statement of what the backend guarantees, how each guarantee was verified, and where it stops.

**Status vocabulary**

| Status | Meaning |
|---|---|
| **Verified** | Exercised by an automated test against a real SpacetimeDB 2.14.1 server in this repository |
| **Designed** | Specified here but not yet demonstrated |
| **Limitation** | A known gap, stated so nobody over-claims |

This is **not** a production security certification. Nothing here has been penetration-tested, and no real identity provider or production host has been deployed.

## 1. Trust boundaries

```
 Responder devices (personal or out-of-band)           Corporate network (assume compromised)
 ┌──────────────────────────┐                          ┌──────────────────────────────┐
 │ Browser: web app + SDK   │                          │ corporate IdP, SIEM, mail,   │
 │ untrusted input          │                          │ endpoints. NOT a dependency  │
 └────────────┬─────────────┘                          └──────────────────────────────┘
              │ TLS: SpacetimeDB protocol / HTTP API
 ┌────────────▼──────────────────────────────────────────────┐
 │ Out-of-band SpacetimeDB host (separate account, separate   │
 │ credentials). Module `sentinelzero`: private tables, views,│
 │ reducers, issuer policy                                    │
 └────────────▲──────────────────────────────────────────────┘
              │ HTTPS, service-principal token
 ┌────────────┴─────────────┐        ┌──────────────────────┐
 │ AI service (FastAPI)     │───────▶│ NVIDIA Nemotron API  │
 │ proposal-only principal  │        │ (untrusted output)   │
 └──────────────────────────┘        └──────────────────────┘
 Out-of-band IdP (dedicated tenant, not corporate SSO) ──▶ issues ID tokens to responders
```

| Actor | Trust | Enforcement point |
|---|---|---|
| Browser user | authenticated by token; **all input untrusted** | `onConnect` issuer policy; every reducer and view checks membership and role |
| Platform admin | the publisher identity, or an identity listed in `platform_admin` | creates organizations, manages issuers, disables users |
| OWNER | full control of one organization | `invite_member`, `revoke_member`, service principals |
| AI service | a service principal bound to one organization; **no human role** | agent tools only, for runs it has claimed and leased |
| LLM output | **untrusted** | can only become PENDING recommendations |
| Other tenants | hostile | must not learn that another tenant's incident exists |
| Database owner / host operator | **fully trusted by the database** | not enforceable inside the module; see section 6 |

## 2. Identity and issuer policy

### 2.1 Identity

`ctx.sender` is derived by the host from the token's `(iss, sub)` pair. No reducer accepts an actor, role or organization membership in its arguments. **Verified:** `authorization.test.ts`, and the "same `sub` yields the same identity" case in `oidcLogin.test.ts`.

### 2.2 Policy states

- **OPEN.** `trusted_issuer` is empty. The host accepts its own minted tokens, and `POST /v1/identity` on a standalone server lets **anyone who can reach it** mint one. OPEN mode is for local development and isolated demos only. `backend_info.issuerPolicyEnforced = false` makes the state visible to every client, including anonymous ones.
- **ENFORCED.** At least one trusted issuer has been added.

| Check | Where | Verified case (`oidcLogin.test.ts`, `issuerPolicy.test.ts`) |
|---|---|---|
| RS256 signature against the issuer's JWKS (fetched through OIDC discovery) | host | a token signed with a rogue key gets HTTP 401 |
| token not expired | host | an expired token gets HTTP 401 |
| issuer is trusted | module `onConnect` | a self-minted local token is rejected on WebSocket and HTTP (403 `AUTH_REQUIRED`) |
| `aud` is in the issuer's audience list (when the list is non-empty) | module | the wrong audience is rejected on WebSocket and HTTP |
| `exp` present | module | a token without `exp` is rejected on HTTP; **accepted on WebSocket** (see 2.3) |
| lifetime `exp - iat` ≤ 86 400 s | module | an over-long token is rejected on HTTP; **accepted on WebSocket** |
| account not disabled | module | a disabled user is rejected (`AUTH_REQUIRED: account disabled`) |
| enrolled machine identities (platform admin, active service principal) exempt from the issuer checks | module | admin and service-principal sessions keep working after enforcement |
| only platform admins manage issuers and audiences | module | a non-admin gets `ACCESS_DENIED` |

### 2.3 Limitation: the WebSocket token re-issue

The 2.14.1 SDK first exchanges the user's token at `/v1/identity/websocket-token`, sending it in the `Authorization` header. The host returns its own signed token, which keeps `iss`, `sub` and `aud` but carries a fresh `iat` and `exp = now + 60 s`. The SDK then connects with `?token=<that token>`. This behaviour was observed directly and is pinned by tests.

Consequences:

1. **Different checks per path.** Issuer and audience checks hold on every path. Expiry and lifetime checks bind only HTTP callers. Mitigation: configure the IdP to always issue `exp` with a lifetime well under 24 h. The host still rejects tokens that have already expired at exchange time.
2. **A short-lived host token appears in the WebSocket URL.** The user's IdP token does not. Reverse proxies, CDNs and load balancers in front of SpacetimeDB **must not log query strings**. This is the SDK's design, not ours. The web client must not add any token to a URL itself.
3. **Expiry does not end an open session.** Revocation and disable remove access live (2.4); token expiry does not. Clients reconnect on refresh.

### 2.4 Membership, revocation and session invalidation (verified)

| Action | Effect on open sessions | Test |
|---|---|---|
| `revoke_member` | the views re-evaluate; rows are **deleted from existing subscriptions** (`onDelete` fires); writes fail; HTTP SQL returns nothing | `revocation.test.ts`, `negativeSecurity.test.ts` ("revoked member" cannot approve on an open session) |
| `set_user_disabled(true)` | the same, platform-wide; new connections are refused | `revocation.test.ts`, `oidcLogin.test.ts` |
| `revoke_service_principal` | every subsequent tool call is denied | `agentAccess.test.ts` |
| requester loses `REQUEST_AGENT_RUN` | the AI tool calls for that run are denied | `agentAccess.test.ts` |
| last OWNER | cannot be revoked | `revocation.test.ts` |

## 3. Authorization

Capabilities are defined in `packages/shared/src/permissions.ts`, a matrix that is frozen for v1. The module enforces it server-side on every reducer and view. The client uses it only to hide controls.

| Role | Can | Cannot |
|---|---|---|
| OWNER | everything in the organization, including members and service principals | reopen incidents (COMMANDER only) |
| COMMANDER | lifecycle transitions, reopen, assign commander, approve and reject tasks and recommendations, everything ANALYST can | manage members |
| ANALYST | create and update incidents, scope, evidence, tasks; request AI runs; view data scope, evidence and audit | transition status, approve |
| RESPONDER | view incident detail, graph, tasks, messages and timeline; send messages; update tasks assigned to them | data scope, evidence, audit hashes, AI activity, any writes beyond those listed |
| OBSERVER | incident summaries only | everything else |

The required negative cases are all verified in `negativeSecurity.test.ts`, which runs 8 tests against a live server:

- **anonymous access:** no tenant rows, and every write is refused;
- **cross-tenant reads:** zero rows, `INCIDENT_NOT_FOUND`, and `verify_agent_run_access` returns `authorized=false`;
- **role escalation:**
  - non-OWNER roles cannot invite, revoke, register service principals, or call platform-admin reducers;
  - an ANALYST cannot transition an incident or make itself commander;
  - not even an OWNER can re-invite an existing member, turn a human into a service principal, or assign a non-COMMANDER as commander;
- **revoked member:** cannot act on an open session;
- **stale status version:** incident, asset, service, impact and task writes return `VERSION_CONFLICT`;
- **duplicate approval:** concurrent COMMANDER and OWNER approvals produce one task and one audit event;
- **unauthorized evidence access:** RESPONDER and OBSERVER see no evidence, and foreign evidence IDs are rejected in transitions, data scopes and recommendations;
- **timeline and audit views:** they follow the role matrix.

### 3.1 Backend review, November 2026 (verified in `hardening.test.ts`)

A review of every reducer, procedure and view against the role matrix, tenant isolation, input limits, audit chain, rate limits and idempotency found and fixed the following. Each fix has a regression test that runs against a live server.

| Finding | Severity | Fix |
|---|---|---|
| Two transactions with the same host timestamp generated the same row ID, because `ctx.newUuidV7()` seeds its RNG from the timestamp alone. The second insert panicked the module ("The instance encountered a fatal error."), so a burst of concurrent writes could lose some of them with an untyped error | High (availability, data loss) | `newId` takes the UUID counter from a persisted `id_sequence` row, so IDs are unique by construction (`security/context.ts`) |
| Most writes on a CLOSED incident still succeeded: task assign/status/approve/reject, messages, AI run requests, recommendation rejection, commander assignment, and the AI's claim and submit | Medium (integrity of closed records, contract violation) | `requireOpenIncident` in every child write; only reopen, `cancel_agent_run` and `agent_complete_run` remain allowed |
| Only messages and AI run requests were rate-limited. Any analyst could flood incidents, graph rows, tasks and evidence (each also appends an audit event), and a service principal could flood `agent_tool_call` rows, in a database shared by every tenant | Medium (cross-tenant denial of service) | New `create_incident`, `incident_write` and `agent_tool_call` limits (`shared/src/limits.ts`) |
| `register_service_principal` checked human memberships through a helper that hides disabled users, so a disabled member could be registered as a service principal and become a human and a machine identity at once after re-enable | Low (needs a platform admin to disable the user first) | Checks every unrevoked membership row (`hasUnrevokedMembership`) |
| The last-OWNER guard counted disabled OWNERs, so the only enabled OWNER could revoke themselves and leave the organization unmanageable | Low | Counts only enabled OWNERs other than the one being revoked |

Reviewed and found sound: every reducer derives the actor from `ctx.sender`; every incident-scoped call goes through `requireIncidentCapability` and returns `INCIDENT_NOT_FOUND` to non-members; OBSERVER holds no write capability; only OWNER and COMMANDER hold `APPROVE_TASK` and `DECIDE_RECOMMENDATION`; a service principal has no membership, so every human reducer denies it, and `agent_submit_recommendation` always writes `PENDING`; every text argument is length- and character-checked; every state change appends its audit event in the same transaction; idempotency keys are scoped by organization, incident, sender or run, and a replay by a different creator is rejected.

## 4. AI boundary (verified in `agentAccess.test.ts` and `negativeSecurity.test.ts`)

- The AI service authenticates as a **service principal** that an OWNER registered for one organization. It is not a member, so every view and private table returns nothing for it, and every human reducer fails.
- It reads only through the `agent_get_*` procedures. Each requires all of the following:
  - the run is RUNNING;
  - the run was claimed by this principal;
  - the run is within its 15-minute lease;
  - the principal is active in the run's organization;
  - the requester still holds the right to request runs.

  Every call is logged in `agent_tool_call`.
- It writes only PENDING `recommendation` rows, at most 10 per run, citing evidence from the same incident or stating uncertainties.
- **Approval is human and server-side.** `approve_recommendation` checks the OWNER or COMMANDER role inside the transaction and creates exactly one task.
- **User intent is checked by the database.** The AI service forwards the user's token to `verify_agent_run_access` and must require `authorized && isRequester && status == REQUESTED && incidentId matches`.

## 5. Audit chain: tamper-evident, not immutable

- **What is written.** Every state change appends an `audit_event` in the **same transaction**. The event extends a per-organization SHA-256 hash chain whose head is stored in `audit_chain_head`.
- **Verifier.** `verifyAuditChain` in `packages/shared/src/auditChain.ts` recomputes every hash and checks genesis, sequence continuity, links, the server head and an optional client pin. It returns `VERIFIED`, `BROKEN` with a reason and sequence number, or `EMPTY`.
- **Tests.** Unit tests in `tests/unit/security.test.ts` cover the intact chain, an edited event, a broken link, a gap, a duplicate, a bad genesis, truncation (detected only with the head) and a full rewrite (detected only with a pin). The live chain verifies end-to-end in `negativeSecurity.test.ts` and `contractExample.test.ts`.
- **Guarantee.** Accidental or partial tampering by anyone without database-owner rights is detected.
- **Non-guarantees:**
  - A **database owner or host operator** can rewrite the whole chain consistently. Only a client that stored an earlier pin, or an external anchor (not implemented), would notice.
  - Deletion of the entire database cannot be detected from inside it.
  - "Immutable" is never claimed.

## 6. Compromised-endpoint and operator limits

The backend cannot defend against the following. They are stated so that nobody infers protection that does not exist:

- **Compromised responder device.** Malware on an authorized user's device acts with that user's role for as long as the session lasts. Mitigations are operational:
  - least-privilege roles;
  - prompt `revoke_member` or `set_user_disabled`, which take effect live;
  - short IdP token lifetimes;
  - using dedicated or clean devices for incident response.
- **Compromised IdP.** Whoever controls a trusted issuer can mint any user's identity. Use a **dedicated out-of-band IdP tenant**, not the possibly compromised corporate SSO. Remove the issuer immediately if it is compromised.
- **Stolen service-principal token.** The server-minted token does not expire. An attacker holding it can read the incident context for runs that are RUNNING and claimed by that principal, and submit PENDING proposals. They cannot approve anything. Rotate the token by revoking the principal and registering a new identity.
- **Stolen platform-admin token.** This token is equivalent to full control of issuers and organizations. Keep it offline and use it only for setup.
- **Host operator or database owner.** They can read and modify everything. Choose a host outside the compromised organization's administrative domain.

## 7. Deployment architecture independent of corporate systems (designed)

The deployment must not depend on anything inside the possibly compromised corporate environment:

| Concern | Choice |
|---|---|
| Backend host | SpacetimeDB 2.14.1 on infrastructure in a **separate cloud account or subscription**, with credentials that are not stored in corporate systems. A managed SpacetimeDB cloud database is also acceptable if its operator is trusted |
| Network | TLS only. The host is reachable from the internet or a dedicated VPN, **not** routed through the corporate network. The reverse proxy does not log query strings |
| Identity | a **dedicated OIDC tenant** (for example, a separate IdP realm) with responder accounts and MFA enrolled **before** an incident. It is configured with `add_trusted_issuer` and `add_trusted_audience`. `/v1/identity` minting is irrelevant once the policy is enforced, because minted tokens are rejected for humans |
| Secrets | the platform-admin and service-principal tokens are kept in a secret store outside corporate systems. `.env` files are never committed; `.env.example` holds placeholders only |
| AI | the AI service runs next to the backend and calls NVIDIA's API directly. It never touches corporate systems |
| Data | `EXERCISE` organizations hold synthetic data only. `LIVE` is reserved and has not been exercised |

## 8. Isolation test plan (designed; **not yet executed**)

Isolation has not been demonstrated. To claim it, run the following checks and record the evidence:

1. **Deploy.** Stand up the host and IdP as described in section 7, with no corporate DNS, VPN, SSO or proxy in the path.
2. **Simulate a corporate outage.** Disconnect or firewall the corporate network and the corporate IdP from the test machines. Verify that responders still sign in through the dedicated IdP, connect, subscribe and write. Record the observed timestamps.
3. **Corporate identity rejected.** Present a token from the corporate IdP. Verify `AUTH_REQUIRED: token issuer is not trusted`, both over the WebSocket and with HTTP 403.
4. **Network path.** Capture traffic, for example with traceroute and packet captures, to show that no backend or AI traffic traverses corporate addresses.
5. **Proxy logs.** Inspect the reverse-proxy logs and confirm that no tokens appear.
6. **Revocation drill.** With a device presumed compromised, revoke its user. Confirm that its open subscription loses rows and its writes fail. This behaviour is already verified locally; the drill re-runs it on the deployment.
7. **Service-principal rotation drill.** Revoke the AI principal mid-run. Confirm that tool calls fail and the run ends in FAILED or EXPIRED.

## 9. Known limitations (summary)

- OPEN mode lets anyone who can reach the server mint identities. Never expose an OPEN server.
- Never add the server's own issuer (`localhost`, or the host's configured issuer) as a trusted issuer in production. Doing so readmits self-minted tokens.
- Expiry and lifetime checks do not bind WebSocket sessions (2.3).
- Service-principal and platform-admin tokens are long-lived bearer tokens.
- The audit chain has no external anchoring. The database owner is fully trusted.
- Rate limits are per identity, and anyone can mint new identities in OPEN mode.
- Platform-level changes (`add_trusted_issuer`, `remove_trusted_issuer`, the audience reducers) are not written to any audit chain, because audit chains are per organization.
- Child-record calls (for example `approve_task` or `revoke_member` with another tenant's ID) answer `NOT_FOUND` for a nonexistent ID but `INCIDENT_NOT_FOUND` or `ACCESS_DENIED` for an existing one. Only incident existence is deliberately hidden; other IDs are unique but not secret.
- `clientMessageId` and the `request_agent_run` key are deduplicated per sender, not per incident. Reusing a key in a second incident is a silent no-op, so clients must generate a fresh key per call.
- No production deployment, isolation drill, penetration test or real-IdP integration has been performed. The web app is still mocked, and the AI service still targets a mock backend (see the handoffs in `INTEGRATION_CONTRACT.md`).
