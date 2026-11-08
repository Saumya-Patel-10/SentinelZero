# SentinelZero Threat Model (backend scope)

> As of contract 1.1.0, `docs/SECURITY_MODEL.md` is the authoritative security statement. It covers the stricter issuer policy (audience, expiry, lifetime), the WebSocket token limitation, the audit verifier, the deployment architecture and the isolation test plan. This table remains the per-threat index.

Scope: the SpacetimeDB module (`packages/spacetime`), the shared contracts (`packages/shared`), and the trust boundary with the FastAPI AI service. The web UI and AI service internals are owned by AGENT-2 and AGENT-3; their obligations appear in section 5.

Test references below are files in `packages/spacetime/tests/integration` unless marked `unit`.

## 1. Assets

- Incident detail, impact graph and data scope. Data scope may reveal regulated-data exposure.
- Evidence metadata and hashes.
- Messages, which contain free-text operational chatter.
- Membership and role assignments, which determine authority.
- Approval decisions and the audit trail.
- The AI service principal token, and user tokens forwarded to FastAPI.

## 2. Trust boundaries and actors

| Actor | Trust |
|---|---|
| Browser user | Authenticated by a SpacetimeDB JWT. **Untrusted input.** Authorization comes from membership and role in the database, never from the client |
| Platform admin | The publisher identity. Can create organizations and disable users. Not a member of any organization by default unless it created it |
| FastAPI AI service | A **service principal** with no human role. It can only call the agent tools for runs it has claimed |
| LLM output | **Untrusted.** It can only become PENDING recommendations, which require human approval |
| Other tenants | Hostile. Must learn nothing, including whether an incident exists |

## 3. Threats and mitigations (verified unless marked)

| # | Threat | Mitigation | Verification |
|---|---|---|---|
| T1 | Reading another tenant's or an unauthorized user's data | All tables are private. Per-sender views re-check active membership and capability on every evaluation. OBSERVER gets summaries only | `incidentAccess.test.ts`, `authorization.test.ts` |
| T2 | Direct subscription or SQL against base tables | Private tables are rejected over WebSocket subscriptions and HTTP `/sql` | `incidentAccess.test.ts` |
| T3 | Impersonation through the request body | No reducer accepts actor or role arguments; actor fields come from `ctx.sender` | `authorization.test.ts` |
| T4 | Privilege escalation through role edits | Only OWNER can invite or revoke. The last OWNER cannot be revoked. Service principals cannot be members, and humans cannot be service principals | `revocation.test.ts`, `agentAccess.test.ts` |
| T5 | Probing for incident existence | Non-members always get `INCIDENT_NOT_FOUND` | `authorization.test.ts` |
| T6 | Lost updates or races | Optimistic `expectedVersion`. SpacetimeDB reducers run serializably | `authorization.test.ts` |
| T7 | Duplicate tasks from repeated or concurrent approvals | Status check plus the unique task key `rec:<id>`. Repeated decisions are no-ops | `workflows.test.ts`, `agentAccess.test.ts` (3 concurrent approvals → 1 task) |
| T8 | Revoked users keep access | Views re-evaluate, so rows are **removed from existing live subscriptions**. New reads return nothing and writes fail. User disable works platform-wide | `revocation.test.ts` |
| T9 | AI acting autonomously | The service principal cannot approve, create tasks or change incidents. Recommendations are always PENDING and must cite same-incident evidence or state uncertainties. At most 10 per run | `agentAccess.test.ts` |
| T10 | AI service over-reach (other tenants, stale runs, revoked requester) | Tool calls require an active service principal in the run's organization, a RUNNING run claimed by the caller, a valid lease (15 minutes), and that the requester still holds `REQUEST_AGENT_RUN`. The sweep expires stale runs | `agentAccess.test.ts` |
| T11 | Browser lies to FastAPI about who it is or which run it means | FastAPI calls `verify_agent_run_access` with the **user's** token, so the database decides. The request must carry a `run_id` the user created | `agentAccess.test.ts` |
| T12 | Spam or resource exhaustion | Rate limits on `send_message` (30/60 s) and `request_agent_run` (5/60 s). Length limits on all text and lists | `workflows.test.ts` (send_message limit only; the request_agent_run limit is not tested) |
| T13 | Stored XSS, bidi spoofing, control characters | Control and bidi-override characters are rejected. HTML is stored verbatim as text and **must be rendered as text** by the UI | `authorization.test.ts` |
| T14 | Audit tampering | Per-organization SHA-256 hash chain, written in the same transaction as the change | `workflows.test.ts`, `contracts.test.ts` (unit) |
| T15 | Secrets or PII in logs and audit | Audit metadata never contains message content (only its length) or tokens. Tool-call summaries contain counts and IDs only | `workflows.test.ts` |
| T16 | Tokens from an untrusted identity provider | `trusted_issuer` and `trusted_audience` allowlists, plus `exp` and lifetime checks, enforced in `onConnect`. Expiry and lifetime bind HTTP only; see SECURITY_MODEL 2.3 | `issuerPolicy.test.ts`, `oidcLogin.test.ts` |
| T17 | Prompt injection through evidence or messages | Text is passed to tools as data. The AI cannot read messages. Every AI output passes through human approval. **AI-side mitigations belong to AGENT-3** | partially verified: a hostile string in evidence is stored as data and cannot cause actions |

## 4. Known limitations and residual risks (not fixed)

1. **The audit log is tamper-evident, not immutable.** Anyone who can publish a module, meaning the database owner, can rewrite tables and recompute the chain. Mitigation outside v1: periodically export `audit_chain_head.lastHash` to an external write-once store.
2. **Rows already delivered stay on the client.** On revocation, SpacetimeDB removes rows from the client cache, but a malicious or compromised client may have copied them. Server-side revocation cannot recall data that has already been read.
3. **Identity is a bearer JWT.** A stolen token gives full access until the platform admin disables the identity with `set_user_disabled`. The module does not enforce token expiry itself; the token lifetime is whatever the issuer sets. The local server mints tokens for anyone. Production needs an external OIDC issuer plus the `trusted_issuer` allowlist.
4. **The trusted-issuer allowlist is opt-in.** While it is empty, any server-issued identity can connect. It still has no access without a membership.
5. **The platform admin is all-powerful** within the module and is seeded as the publisher identity. Protect the publisher credentials.
6. **Procedures are an unstable SpacetimeDB 2.14.1 API** (`ctx.withTx`). Tool procedures catch typed errors and return a `result`. Any unexpected host failure surfaces as HTTP 500, which FastAPI must treat as `SERVICE_UNAVAILABLE`.
7. **Rate limiting is per identity**, so it does not stop an attacker who mints many identities. Those identities have no membership, though, and cannot write incident data.
8. **Evidence integrity**: `sha256` is caller-supplied. The backend validates its format but cannot verify it against file contents, which are never uploaded.
9. **Views are recomputed per subscriber.** Very large organizations may need performance work, which has not been load-tested.

## 5. Obligations on other components

- **Web (AGENT-2)**:
  - Render all text as text, with no `dangerouslySetInnerHTML`.
  - Never store tokens anywhere except the SDK's local storage key.
  - Show EXERCISE or LIVE, and the inference mode, prominently.
  - Treat `roleHas` as display logic only.
- **AI service (AGENT-3)**:
  - Keep the service token in a secret store. **Never log tokens, Authorization headers, or HTTP bodies that contain user data.**
  - Forward the user token only to `verify_agent_run_access`.
  - Treat `[1, ...]`, 530 and any other non-2xx exactly as section 9.2 of `docs/api-contracts.md` specifies.
  - Never fabricate evidence IDs, because the backend rejects them.
  - Label SIMULATED and FIXTURE runs honestly.
- **Simulator**: use `dataClass = EXERCISE`, and never load real PHI or PII.
