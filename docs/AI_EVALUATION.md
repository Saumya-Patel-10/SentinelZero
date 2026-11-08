# SentinelZero — AI Evaluation

Status date: **2026-11-07**. Branch: `agent/03-nemotron-real-backend`.

This document records how Nemotron agent quality is measured, what results are
real versus simulated, and what remains blocked.

---

## 1. Evaluation scope

Per the quality gates (docs/QUALITY_GATES.md, Gate 3 — NVIDIA), evaluation
covers:

- End-to-end task completion (request → run → tool loop → PENDING recommendation → human approval → task)
- Tool-call correctness (allowlist, authorization, bounds, timing)
- Evidence validity (facts cite returned evidence IDs; no fabrication)
- Permission denials (cross-tenant, wrong role, revoked access)
- Duplicate approval prevention (idempotency key `rec:<id>`)
- Provider failure handling (auth, timeout, 5xx, outage)
- Latency (real inference vs scripted overhead)

---

## 2. Scripted results (verified)

All scripted tests run offline with zero network latency. They measure service
orchestration overhead, **not** NVIDIA inference latency.

| Metric | Result | Source |
|---|---|---|
| pytest suite | 42 passed, 1 skipped | `pytest -q` |
| Playwright API smoke | 4 passed | `npm run test:api` |
| Scripted run overhead | ~6.6 ms mean, ~6.5 ms p50, ~7.2 ms p95 (10 runs) | `tests/performance/measure_latency.py` |
| Tool calls per run | 5 read-only calls | test_workflow.py |
| Provider turns per run | 2 (tool selection + final JSON) | test_workflow.py |
| Wire round-trip assertions | 16/16 true | `evidence/tool-roundtrip-simulated.json` |

Scripted latency numbers are explicitly **not** model latency. They are in-process
ASGI + orchestration overhead with a zero-latency provider.

---

## 3. Live NVIDIA results (blocked)

| Metric | Status |
|---|---|
| Real Nemotron inference | **Not executed** — no `NVIDIA_API_KEY` available |
| Live tool-calling quality | Unverified |
| Real inference latency | Unmeasured |
| Live run completion rate | Unmeasured |

The OpenAI-compatible wire protocol (`POST /chat/completions`, `tools`,
`tool_calls`, `role="tool"`, `response_format`) was verified against a local
`httpx.MockTransport` test double. That proves request/response wiring, **not**
model behavior.

**Blocker:** no `NVIDIA_API_KEY` is available in this environment. To close:
1. Obtain an NVIDIA API key with access to `nvidia/nemotron-3-super-120b-a12b`.
2. Set `NVIDIA_API_KEY` and `AI_LIVE_TESTS=1`.
3. Run `pytest -m live -q` from `services/ai`.
4. Preserve the live test output with the release.

---

## 4. Test matrix

| Suite | Coverage |
|---|---|
| test_health.py | Truthful health labels, security headers, safe envelopes, body limit, docs gating |
| test_authz.py | verify_agent_run_access denial, non-requester, non-REQUESTED run, incident mismatch |
| test_workflow.py | Scripted end-to-end run, 5 read-only tools, PENDING recommendation, immutability, no secrets |
| test_agent_bounds.py | Step limit, missing tool round trip, cancellation, unknown run |
| test_wire_roundtrip.py | OpenAI-compatible protocol, response_format fallback, content parts, malformed responses, custom endpoint not labeled LIVE |
| test_schemas.py | Schema validation, evidence fabrication rejection, injection detection, redaction |
| test_limits.py | Rate limiting, per-user concurrency |
| test_store.py | Run lifecycle, terminal immutability, TTL, max runs |
| test_simulator.py | Deterministic scenario, tamper detection, invariants |

---

## 5. Model behavior notes

- The scripted provider is **deterministic and intentionally simple**. It always
  performs the same 5 read tool calls and produces the same recommendation
  shape. It is **not** evidence of Nemotron model quality.
- Every fact cites evidence IDs returned by `get_evidence_summaries`.
- Fabricated evidence IDs cause the run to fail validation (`AI_OUTPUT_INVALID`).
- `propose_task` proposals require human approval (`status=PENDING`) and cannot
  carry approval or status fields.
- Prompt-injection patterns are detected and recorded; they do not affect
  authorization.

---

## 6. What is not evaluated

| Gap | Reason |
|---|---|
| Live model latency | No NVIDIA API key |
| Model tool-selection quality | No live inference |
| Real Agent 1/SpacetimeDB load | Backend contract frozen; no production deployment |
| RS256 token flow | HS256 only in tests |
| Browser AI panel integration | Web mock not replaced with real SDK |
| Load / soak testing | No sustained throughput test |
| Red-team / model safety corpus | No adversarial evaluation |
