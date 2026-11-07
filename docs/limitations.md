# SentinelZero AI Service — Limitations and Verified Scope

Status date: **2026-11-07**. Branch: `agent/03-ai-demo-qa`.

This document separates what was actually exercised from what is designed,
proposed, or still blocked. It exists so nobody has to guess which claims are safe.

> **Headline limitation:** live NVIDIA Nemotron inference was **not executed**
> because no `NVIDIA_API_KEY` was available. The OpenAI-compatible tool protocol was
> verified only against a local wire test double. Model behavior, tool-selection
> quality, and real latency remain unverified.

---

## 1. Status vocabulary

| Status | Meaning |
|---|---|
| **Verified** | Exercised by an automated test or recorded artifact in this branch, with the observed result recorded. |
| **Implemented, unverified** | Code exists and is unit-tested in isolation, but has not run against the real external system. |
| **Proposed / MOCK** | A typed contract or fallback exists so work can proceed; it is not a real integration. |
| **Not implemented** | Out of scope for this branch. |

---

## 2. Verified in this branch

- Caller authentication: HS256 signature, issuer, audience, expiry, organization,
  and role checks; fail-closed when auth is unconfigured.
- Incident authorization: membership and role re-checked on analyze, run read,
  cancel, and submit; cross-tenant access denied without confirming existence.
- Exact read-only tool allowlist: `get_incident`, `get_assets`,
  `get_dependencies`, `get_open_tasks`, `get_evidence_summaries`; plus the
  proposal-only `propose_task`.
- Forbidden tools and incident-id arguments are rejected; a forbidden tool is never
  executed.
- Evidence-linked schema validation: fabricated evidence ids fail the run;
  evidence-backed tasks require ids; text is length-bounded and markup-checked.
- Proposal-only behavior: model output cannot set `requires_human_approval=false`;
  submission is forced to `PENDING_HUMAN_APPROVAL`; no approve/execute endpoint.
- Bounds: steps, tool calls, tool-result size, context size, wall-clock deadline,
  request body size, per-user concurrency, per-minute rate limit.
- Cancellation and terminal-state immutability, including the concurrency-slot
  release path.
- Secret handling: `/health` exposes booleans only; run payloads contain no prompt,
  provider body, or key; logs redact bearer/`nvapi-` forms.
- Redaction of email, SSN, MRN, phone, DOB, API tokens, and bearer tokens before
  tool output reaches the model.
- Prompt-injection marker detection (recorded, not treated as authorization).
- Deterministic synthetic hospital exercise with tamper detection and a stable
  SHA-256.
- OpenAI-compatible wire round trip at the HTTP level (`tools`, `tool_choice`,
  assistant `tool_calls`, `role="tool"` follow-ups, `response_format`).
- Test results: **115 passed, 1 skipped** (pytest); **4 passed** (Playwright API).
- Simulated artifacts: 16/16 wire assertions; 10/10 scripted runs completed with
  ~6.6 ms mean service overhead.

---

## 3. Implemented but unverified

### 3.1 NVIDIA Nemotron live inference

- **State:** the client, protocol handling, retries, error mapping, and model
  configuration are implemented. No live request was made.
- **Not established:** whether the default model id is available to your account;
  whether the model reliably emits valid tool calls and schema-valid JSON; real
  latency, token usage, rate limits, and failure rates.
- **Closure:** run `pytest -m live` with `NVIDIA_API_KEY` and `AI_LIVE_TESTS=1`
  against the exact model and endpoint; preserve the output in the release.

### 3.2 Agent 1 / SpacetimeDB backend (`HttpBackendClient`)

- **State:** `MOCK-1` contract implemented as a typed HTTP adapter; only the
  in-memory simulator-backed backend is tested.
- **Not established:** endpoint paths, response schemas, auth header behavior,
  reducer semantics, idempotency behavior, or error mapping against a real
  service.
- **Closure:** freeze the contract with Agent 1, replace paths only after
  publication, add contract tests against the real service, and remove the
  `MOCK_AWAITING_AGENT1` label.

### 3.3 RS256 token flow

- **State:** configuration accepts a PEM public key and startup validation exists.
- **Not established:** end-to-end RS256 verification, key rotation, or JWKS
  retrieval. Tests exercise HS256 only.
- **Closure:** add a generated RSA keypair test, an expired/rotated-key test, and a
  production issuer integration test.

### 3.4 Playwright browser smoke

- **State:** `web.spec.ts` checks page render and uncaught errors; it is optional
  and skips without `APP_BASE_URL`.
- **Not established:** the actual AI panel UI, streaming/progress rendering, or
  approval handoff in the web app. The browser spec was not run here.
- **Closure:** start the web app, set `APP_BASE_URL`, run `npm run test:web`, and
  add selectors/assertions for the AI panel.

---

## 4. Production readiness gaps

| Gap | Current behavior | Risk | Closure criteria |
|---|---|---|---|
| Run persistence | In-memory `RunStore`; lost on restart | Audit/history loss; in-flight runs disappear | Persist canonical `AgentRun`/`AgentToolCall` records in the operational backend |
| Submission persistence | In-memory, process-local idempotency | Duplicate proposals after restart or across workers | Durable idempotency keys and transactional submission |
| Distributed rate limits | Token bucket and concurrency limiter are process-local | Limits multiply with worker count | Shared limiter (Redis/DB) or single-writer routing |
| Token revocation | No `jti` replay/revocation check | A stolen token remains valid until expiry | Issuer-side revocation, short TTLs, rotation |
| Observability | Structured logs + `/health` only | No metrics, traces, dashboards, or alerting | Export metrics/traces; alert on provider errors, failures, latency |
| Model lifecycle | One configured model id; no fallback | Model retirement or capacity changes break the service | Model allowlist, canary, fallback policy, re-run live tests on change |
| Provider cost control | Per-user rate/concurrency only | A permitted user can consume budget | Org-level quotas, budget alarms, max tokens per period |
| Multi-worker correctness | Background tasks live in one process | Run reads may hit a different worker | Sticky routing or shared run store/queue |
| Graceful shutdown | Lifespan closes the runtime | In-flight runs may be interrupted | Drain/requeue policy and shutdown tests |
| Load/soak | Not measured | Unknown behavior at sustained concurrency | Load profile with real provider latency and multiple users |

---

## 5. Security caveats

- **Redaction is best-effort.** It uses pattern matching over text and structured
  data. It is not a DLP system and can miss novel formats. Do not send raw patient
  records or secrets into prompts.
- **Prompt injection is mitigated, not solved.** Detection is heuristic; the
  stronger controls are the read-only allowlist, closed tool schemas, server-side
  incident scope, and human approval. Tool output is untrusted data.
- **The model can be wrong.** Facts and proposals are bounded and evidence-linked,
  but a human must review them. A valid citation is not proof that the statement
  is correct.
- **No approval capability by design.** Keep approval in the operational backend.
  Do not add an approve/execute endpoint to this service.
- **In-memory run data is not durable.** Do not treat it as an audit record.
- **Cancellation is best-effort.** The run is marked `CANCELLED` and will not
  produce a new recommendation, but an in-flight provider HTTP request may already
  have been sent.
- **The test JWT secret is not a deployment secret.** `tests/conftest.py` and the
  Playwright config use local-only secrets. Never reuse them.
- **HS256 is a demo/shared-service choice.** Production should prefer RS256 with a
  published public key or a rotated secret from a secret manager.
- **Docs are disabled in production.** `AI_ENABLE_DOCS` is ignored when
  `AI_ENVIRONMENT=production`.

---

## 6. Data, model, and measurement limitations

- All incident data is **synthetic** and fictional. Identities use `.invalid`;
  records are labeled `EXERCISE`. Nothing here is real patient data.
- The exercise is **not** a HIPAA, GDPR, or clinical-safety validation. It is a
  tabletop scenario for software behavior.
- `estimated_records`, confidence values, and evidence hashes are synthetic.
- Exfiltration remains `UNKNOWN` by construction. Tests explicitly reject attempts
  to confirm it without evidence.
- Scripted output is deterministic and intentionally simple. It is **not** evidence
  of model quality.
- The performance artifact measures in-process service overhead with a
  zero-latency provider: ~**6.59 ms mean**, ~**6.53 ms p50**, ~**7.22 ms p95** over
  10 runs. It is **not** NVIDIA latency.
- No streaming responses. The API is asynchronous with polling.
- No multi-model comparison and no red-team evaluation corpus.
- No prompt or raw provider body retention (by design). This limits post-incident
  debugging and requires external tracing if needed.

---

## 7. Claims we do not make

- "Live NVIDIA Nemotron inference is verified." — Not in this environment.
- "The model reliably produces correct incident analysis." — Not measured.
- "Production-ready." — No; see the gaps above.
- "HIPAA compliant." — No compliance assessment was performed.
- "Agent 1 integrated." — Only MOCK-1 is present.
- "Runs and approvals are durable." — Runs are in memory; approval is out of scope.
- "The AI can contain or remediate the incident." — It can only propose.
- "Latency is X ms against NVIDIA." — Only scripted overhead was measured.

---

## 8. Closure checklist for a stronger claim

1. `NVIDIA_API_KEY` available; `pytest -m live` passes for the exact model id.
2. Preserve live test output and a live run record with `LIVE_NVIDIA_INFERENCE`.
3. Agent 1 contract frozen; replace MOCK-1 paths; contract tests hit the real
   service.
4. Durable run/tool-call/submission storage with restart tests.
5. Shared rate/concurrency limiting and a multi-worker test.
6. RS256 or rotated-secret auth with revocation tests.
7. Browser E2E against the real AI panel, including approval handoff.
8. Load/soak results with real provider latency.
9. Security review of redaction, injection handling, logging, and egress policy.
10. Organizational privacy/security review before any real data.
