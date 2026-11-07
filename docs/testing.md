# SentinelZero AI Service — Testing

Status date: **2026-11-07**. Branch: `agent/03-ai-demo-qa`.
Environment used for the recorded runs: Windows 11, Python 3.12.10,
pytest 9.2.0, Playwright 1.65.0.

> **No test in the default suite calls NVIDIA or any paid service.** The wire
> protocol is exercised with `httpx.MockTransport`; the end-to-end workflow uses
> the deterministic scripted provider and synthetic simulator state. The only test
> that would contact NVIDIA is marked `live` and is skipped unless both a key and
> `AI_LIVE_TESTS=1` are present.

---

## Recorded results

### 1. Python suite

```powershell
cd services/ai
.\.venv\Scripts\python.exe -m pytest -q
```

```text
..................................................s..................... [ 62%]
............................................                             [100%]
=========================== short test summary info ===========================
SKIPPED [1] tests\test_live_nvidia.py:39: set AI_LIVE_TESTS=1 to explicitly allow paid live inference
115 passed, 1 skipped in 2.46s
```

The skipped test is `test_live_nemotron_tool_round_trip`. The second live-suite
test, `test_live_provider_descriptor_without_key_is_unconfigured`, runs offline and
passes.

### 2. Simulator determinism and invariants

```powershell
cd C:\Data\Saumya\AI-Projects\SentinelZero-agent03
python -m simulator verify
python -m simulator status
```

```json
{
  "ok": true,
  "phase": "injected",
  "scenario_id": "hospital_ransomware_v1",
  "state_sha256": "6aad55610eb74e8744b0f137c6f58a7af6f1750ca5ff316d82d582d133ee4d5c",
  "errors": [],
  "counts": {
    "assets": 12,
    "audit_events": 16,
    "data_scopes": 3,
    "evidence_references": 12,
    "memberships": 4,
    "operational_impacts": 3,
    "service_dependencies": 8,
    "services": 3,
    "tasks": 6,
    "users": 4
  }
}
```

`status` additionally reports `exercise_label: "EXERCISE"` and
`exfiltration_status: ["UNKNOWN"]`.

### 3. Simulated wire evidence

```powershell
cd services/ai
.\.venv\Scripts\python.exe scripts\generate_evidence.py
```

```text
{"ok": true, "path": "...\\services\\ai\\evidence\\tool-roundtrip-simulated.json", "checks": 16}
```

Artifact: `services/ai/evidence/tool-roundtrip-simulated.json`

- Label: `SIMULATED_MODEL_OUTPUT`
- `live_inference: false`
- Transport: local `httpx.MockTransport` test double
- All **16/16** assertions true, including:
  - correct `/chat/completions` URL and bearer header
  - `tools` declared, `tool_choice="auto"`
  - assistant `tool_calls` followed by `role="tool"` messages
  - second turn carries `response_format` JSON schema
  - only allowlisted tools were called
  - run completed, recommendation pending human approval
  - exfiltration uncertainty recorded
  - no secret material in the run

This artifact proves the request/response wiring, **not** live model behavior.

### 4. Scripted service overhead

```powershell
cd services/ai
.\.venv\Scripts\python.exe tests\performance\measure_latency.py --runs 10
```

```json
{
  "count": 10,
  "min_ms": 6.14,
  "mean_ms": 6.59,
  "p50_ms": 6.53,
  "p95_ms": 7.22,
  "max_ms": 7.22
}
```

All 10 runs completed with 2 provider calls and 5 tool calls each. Artifact:
`services/ai/evidence/performance-simulated.json`, labeled
`SIMULATED_MODEL_OUTPUT`.

**Interpretation:** this is in-process ASGI + orchestration overhead with a
zero-network, zero-latency provider. It is **not** NVIDIA inference latency. Real
network/model latency requires the live test.

### 5. Playwright API smoke

```powershell
cd services/ai/tests/e2e
npm install
$env:AI_E2E_PYTHON = "C:\path\to\services\ai\.venv\Scripts\python.exe"
npm run test:api
```

```text
Running 4 tests using 1 worker

  ok 1 [api] › health is truthful about the simulated provider (17ms)
  ok 2 [api] › analysis requires a bearer token (8ms)
  ok 3 [api] › scripted analysis completes with evidence-linked pending proposals (22ms)
  ok 4 [api] › unknown runs use the safe error envelope (5ms)

  4 passed (1.3s)
```

The config starts the FastAPI service on `127.0.0.1:8100` with scripted + memory
mode, seeds the simulator, and mints local HS256 test tokens. No NVIDIA calls.

### 6. Browser smoke (optional, not part of the recorded pass)

`web.spec.ts` is skipped unless `APP_BASE_URL` is set. It was **not run against a
web app in this environment**; the last invocation reported 1 skipped. To run it:

```powershell
$env:APP_BASE_URL = "http://127.0.0.1:5173"
$env:AI_PANEL_SELECTOR = "[data-testid='ai-run-panel']"   # optional
npm run test:web
```

### 7. Live NVIDIA check — not executed

```powershell
cd services/ai
$env:NVIDIA_API_KEY = "nvapi-..."
$env:AI_LIVE_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -m live -q
```

**Result in this environment: not executed.** No `NVIDIA_API_KEY` was available.
Live inference, live latency, and model tool-calling quality remain unverified.
See `docs/limitations.md` for closure criteria.

---

## Test matrix

| Suite | What it covers |
|---|---|
| `test_health.py` | Truthful provider/backend labels; no secrets; security headers; request-id echo/sanitize; safe error envelopes; body limit before auth; docs disabled in production; body scope ignored. |
| `test_authz.py` | Missing/invalid/expired tokens; wrong issuer/audience; missing org; unknown role; role-to-membership mismatch; cross-tenant denial; incident non-enumeration; revoked membership; commander read; fail-closed when auth is unconfigured. |
| `test_workflow.py` | Scripted end-to-end run; five read-only tool calls; pending recommendation; no prompt/secret in run payload; repeated reads; terminal immutability; unknown-run 404. |
| `test_wire_roundtrip.py` | OpenAI-compatible `tools`/`tool_calls`/`role="tool"` round trip; `response_format` 400 fallback; content parts and dict arguments; malformed provider responses; unconfigured provider fails closed; custom endpoint is not labeled live NVIDIA. |
| `test_agent_bounds.py` | Provider auth/timeout/5xx failures; missing tool round trip; forbidden tool denied without execution; `incident_id` argument rejected; fabricated evidence id; evidence-backed task without evidence; step/tool-call/context limits; propose-only pending tasks; duplicate collapse; prompt injection + redaction; cancel behavior and authorization. |
| `test_submit.py` | Pending-only submission; idempotent duplicate; commander submission. |
| `test_schemas.py` | Extra fields forbidden; `requires_human_approval` cannot be false; confidence/status bounds; evidence id pattern; unsafe markup rejection; evidence validation; dedupe/cap; JSON extraction; exact tool allowlist and absence of forbidden names; injection detection; redaction bounds. |
| `test_limits.py` | Token-bucket refill/block; per-key buckets; concurrency acquire/release; endpoint 429; per-user concurrent-run 429. |
| `test_store.py` | Create/read; terminal immutability; cancelled run not overwritten; TTL pruning; max-run eviction; submission recording. |
| `test_simulator.py` | Scenario identity; deterministic rebuild; phase counts; EXERCISE and `UNKNOWN` invariants; tamper detection for exfiltration, audit chain, evidence hash, state hash; isolated CLI files; invalid scenario/schema/phase rejection. |
| `test_live_nvidia.py` | Opt-in full live analyze workflow; offline descriptor check for a keyless live configuration. |
| `tests/e2e/api.spec.ts` | Health truthfulness; bearer requirement; scripted analyze with five tools and pending proposals; idempotent submit; 404 envelope. |
| `tests/e2e/web.spec.ts` | Optional page-render and uncaught-error smoke; skips without `APP_BASE_URL`. |

---

## Test design notes

- The default provider is `ScriptedNemotronProvider`, which is selected only when
  `AI_PROVIDER_MODE=scripted`. Every run it produces is labeled
  `SIMULATED_MODEL_OUTPUT`.
- Wire tests use a sequenced `httpx.MockTransport` (`FakeNemotron` in
  `tests/conftest.py`). They inspect the actual request URL, headers, and JSON
  body, and return realistic OpenAI-compatible responses.
- Simulator tests build state in temporary files; they do not touch
  `simulator/.state/state.json`.
- The test-only HS256 secret lives in `tests/conftest.py` and must never be used
  outside tests. Playwright uses a separate local-only secret.
- Rate limits are raised in the test settings so functional tests are not
  accidentally throttled; dedicated tests exercise the limiter directly.
- The default `pytest` invocation does not require network access.

---

## What is not covered

| Gap | Why it matters | How to close |
|---|---|---|
| Live NVIDIA inference | Wire correctness does not prove model behavior, tool selection, or schema compliance. | Run `pytest -m live` with a key and preserve the output. |
| Real Agent 1 / SpacetimeDB backend | `HttpBackendClient` is an unverified MOCK-1 proposal; only the memory simulator is tested. | Freeze the contract, add contract tests against a real service, update paths and schemas. |
| RS256 token flow | Only HS256 is exercised; RS256 has configuration validation but no end-to-end test. | Add a generated RSA keypair test and a key-rotation test. |
| Browser integration | The web spec only checks render/no uncaught errors, and was not run here. | Start the web app, set `APP_BASE_URL`, run `npm run test:web`, then add panel-specific assertions. |
| Durability | The run store is in memory; restart loses runs and submissions. | Move to the canonical Agent 1 run store and add restart/recovery tests. |
| Distributed limits | Rate and concurrency limiters are process-local. | Add a shared limiter and multi-worker tests. |
| Load and soak | No sustained-throughput, memory-growth, or deadline-under-load test. | Add a load profile with real provider latency and multi-user concurrency. |
| Model safety and quality | No red-team corpus, no cross-model comparison, no false-positive/negative measurement. | Build an evaluation set and record results per model/version. |
| Real data / HIPAA validation | The exercise is synthetic and `.invalid`; this is not a compliance certification. | Complete organizational privacy/security review before any real data. |

Scripted latency numbers must never be presented as model latency. The artifact
itself says so under `measurement` and `not_measured`.

---

## Reproduce everything

```powershell
# Python
cd services/ai
.\.venv\Scripts\python.exe -m pytest -q

# Simulator
cd ..\..
python -m simulator run
python -m simulator verify

# Evidence + perf
cd services\ai
.\.venv\Scripts\python.exe scripts\generate_evidence.py
.\.venv\Scripts\python.exe tests\performance\measure_latency.py --runs 10

# Playwright API
cd tests\e2e
npm install
$env:AI_E2E_PYTHON = "C:\path\to\services\ai\.venv\Scripts\python.exe"
npm run test:api
```

Artifacts are written to `services/ai/evidence/`. Runtime state is written to
`simulator/.state/state.json`. Both locations are gitignored where appropriate
(`evidence/*.runtime.json`, `simulator/.state/`).
