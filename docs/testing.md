# SentinelZero AI Service — Testing

Status date: **2026-11-08**. Branch: `integration/multi-agent`.
Environment: Windows, `services/ai/.venv` (Python 3.12), pytest 9.2.0.
`pip install -e ".[dev]"` succeeded with `pytest-cov==7.1.0`.

The default suite does not call NVIDIA. Wire tests use `httpx.MockTransport`.
Scripted runs use `ScriptedNemotronProvider` and are labeled
`SIMULATED_MODEL_OUTPUT`. The only test that would contact NVIDIA is marked
`live`.

---

## Recorded results

### 1. Python suite

```powershell
cd services/ai
.\.venv\Scripts\python.exe -m pytest -q
```

Three consecutive runs, same machine, after the orchestrator fixes:

| Run | Result | Time |
|---|---|---|
| 1 | 79 passed, 1 skipped | 11.11s |
| 2 | 79 passed, 1 skipped | 11.13s |
| 3 | 79 passed, 1 skipped | 12.05s |

No order-dependent failures showed up across the three runs. The skip is
`test_live_nemotron_tool_round_trip`: the default suite does not set
`AI_LIVE_TESTS=1`. `test_live_provider_descriptor_without_key_is_unconfigured`
runs in the default suite and passes offline.

### 2. Live marker

```powershell
cd services/ai
$env:AI_LIVE_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -m live -q
```

```text
SKIPPED [1] tests/test_live_nvidia.py: NVIDIA_API_KEY is not configured
1 skipped, 79 deselected
```

No API key was present, and none was searched for. Live tool selection, schema
compliance, and latency are unverified.

### 3. Simulator verify

From the repository root, using the AI service virtualenv:

```powershell
services\ai\.venv\Scripts\python.exe -m simulator verify
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

### 4. Not re-run in this session

These older artifacts were not regenerated on `integration/multi-agent`:

- `tests/performance/measure_latency.py` (the previous ~6.6 ms figure is the single-loop scripted overhead from 2026-11-07)
- `scripts/generate_evidence.py`
- Playwright `tests/e2e` (`api.spec.ts` still expects the pre-orchestration payload: five tools, `approval_status: PENDING_HUMAN_APPROVAL`, and `backend.contract_status: MOCK_AWAITING_AGENT1`; `start_service.py` still sets `AI_BACKEND_MODE=memory`, which `Settings` rejects)

Do not quote those artifacts as results for this branch.

---

## Agent modes covered

`AI_AGENT_MODE` defaults to `orchestrated`.

| Mode | What the tests lock |
|---|---|
| `orchestrated` | Four sub-agents in order: triage, impact, containment, communications. Each call is limited to that step's tool allowlist. Only containment may call `propose_task`. Communications has no tools and produces the sitrep. One run-wide step and tool budget. A failed sub-agent does not call `agent_submit_recommendation`. `GET /v1/agent-runs/{run_id}` returns `subagents` in that order and `sitrep` (empty until communications completes; at most 2000 characters). |
| `single` | The original one-loop agent. `test_scripted_run_completes_with_tool_round_trip` and `test_openai_compatible_tool_round_trip` set `agent_mode=single` and still require five read tools, two provider turns, and a `PENDING` recommendation. Sub-agent rows are `SKIPPED` and `sitrep` is empty. |

The scripted provider reads `[sentinelzero-subagent:triage|impact|containment|communications]` and returns schema-valid JSON for that step. Output is still `inference_mode=SIMULATED`.

---

## Test matrix

| Suite | What it covers |
|---|---|
| `test_health.py` | Scripted health labels, no secrets, security headers, request id, safe error envelopes (`METHOD_NOT_ALLOWED` on 405), body limit, docs disabled in production, body incident id ignored. |
| `test_authz.py` | Missing bearer token; `verify_agent_run_access` denial; non-requester; run not `REQUESTED`; incident id mismatch. |
| `test_workflow.py` | Single-mode scripted round trip (five reads, two provider calls, `PENDING`); no prompt or secret in the run payload; repeated reads; unknown run 404; `run_id` required. |
| `test_orchestrator.py` | Per-sub-agent allowlist denial (`DENIED`, tool not executed); shared tool budget across sub-agents; injection in a prior sub-agent summary wrapped as untrusted data and not obeyed; sub-agent schema failure submits nothing; scripted orchestrated completion with sitrep and four `COMPLETED` sub-agents. |
| `test_wire_roundtrip.py` | Single-mode OpenAI-compatible round trip; orchestrated round trip (per-step tool lists, `role=tool` follow-ups, JSON schema names, sitrep); `response_format` 400 fallback; content parts; malformed responses; unconfigured provider; custom host is not labeled live NVIDIA. |
| `test_agent_bounds.py` | Step limit; missing tool round trip; cancel while the provider is in flight; unknown run 404. |
| `test_limits.py` | Token bucket, per-key buckets, concurrency limiter, endpoint 429, per-user concurrency 429. Rate and concurrency keys are the caller, not the run id. |
| `test_schemas.py` | Extra fields, bounds, evidence id pattern, unsafe markup, fabricated evidence, duplicate proposal collapse, tool allowlist, injection categories, redaction bounds. |
| `test_store.py` | Create/read, terminal immutability, cancel not overwritten, TTL, max-run eviction. |
| `test_simulator.py` | Scenario identity, deterministic rebuild, phase counts, exercise and `UNKNOWN` invariants, tamper detection, CLI verify. |
| `test_live_nvidia.py` | Opt-in live analyze (skipped here); offline check that a keyless live provider is unconfigured. |

---

## Test design notes

- `AI_PROVIDER_MODE=scripted` is the only way to select the scripted provider. Production rejects it.
- Tests pass `agent_mode` explicitly. The suite default inside `test_settings` is `orchestrated`.
- The fake SpacetimeDB is function-scoped. `set_run` controls status and incident id for `verify_agent_run_access`. Handler replacements do not leak into the next test.
- Cancel is tested with a provider that blocks until the cancel flag is set, so a fast scripted run cannot finish first.
- Wire tests inspect the request URL, headers, and JSON. They use a local test double and a fake bearer value that is not a real NVIDIA key.
- Simulator tests build or verify the exercise state. `python -m simulator verify` above used the repo `simulator/.state/state.json`.

---

## What is not covered

| Gap | Why it matters | How to close |
|---|---|---|
| Live NVIDIA inference | The wire double does not prove tool selection or schema compliance of the real model. | Run `pytest -m live` with `NVIDIA_API_KEY` and `AI_LIVE_TESTS=1`. |
| Real SpacetimeDB at `127.0.0.1:3411` | Pytest uses `httpx.MockTransport`. The HTTP client is implemented; this session did not call a running database. | Start SpacetimeDB, register a service principal, and run one scripted analyze against it. |
| RS256 | Tests mint HS256. The simulator backend verifies HS256 locally. | Add an RSA keypair test. |
| Playwright | `api.spec.ts` and `start_service.py` still describe the old single-loop, `memory` backend contract. | Update the spec for `subagents`/`sitrep` and `AI_BACKEND_MODE=simulator` or `spacetimedb`, then re-run it. |
| Durability | `RunStore` is in memory. | Persist runs in SpacetimeDB and add a restart test. The service already submits the recommendation and terminal status there when a real backend is configured. |
| Load | No soak run, and the old latency script was not re-run for the seven-call orchestrated path. | Re-measure with `measure_latency.py` after it learns the orchestrated counts. |

---

## Reproduce

```powershell
cd services/ai
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest -q

cd ..\..
services\ai\.venv\Scripts\python.exe -m simulator verify

cd services\ai
$env:AI_LIVE_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -m live -q
```
