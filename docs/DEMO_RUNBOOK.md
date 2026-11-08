# SentinelZero — 3-Minute Sponsor Demo Runbook

Status date: **2026-11-07**. Branch: `agent/03-nemotron-real-backend`.
Audience: sponsor, reviewer, leadership.

> **Truthfulness:** the browser command center runs on local exercise fixtures until
> `VITE_STDB_URI` and an OIDC session are wired. The AI button stays on the labeled
> exercise path until `configureAIAuth` is installed. A scripted provider can complete
> the four-stage orchestrator offline. Live NVIDIA inference requires `NVIDIA_API_KEY`
> and `AI_LIVE_TESTS=1`, and it is not part of the default demo.

---

## Demo arc (3 minutes)

| Time | Segment | What the audience sees |
|---|---|---|
| 0:00–0:25 | Exercise console | Open the command center. The badge reads EXERCISE REPLAY. The role switcher changes the local user only. |
| 0:25–0:50 | Incident and graph | Walk the lifecycle, impact graph, and data-scope ledger. Figures come from the fixture, not a live hospital feed. |
| 0:50–1:15 | Compromised asset → affected services graph | Analyst opens the incident; the impact graph shows assets, services, dependencies, and operational impacts. |
| 1:15–2:05 | Labeled analysis | Start analysis. Without an authenticated AI session the panel shows SIMULATED and EXERCISE SCENARIO. A configured scripted service shows triage, impact, containment, and communications, then one PENDING recommendation. |
| 2:05–2:30 | Commander approval creates one task | COMMANDER approves the recommendation in the backend; exactly one task is created with idempotency key `rec:<id>`. Responder sees the task. |
| 2:30–2:50 | Scope + secure chat + audit | Data scopes show exfiltration status UNKNOWN. Chat messages are authenticated and persisted. Audit chain verifies. |
| 2:50–3:00 | Outage independence + summary | Demonstrate that SentinelZero stays online when the simulated corporate network is down. Summary of verified vs unverified claims. |

---

## Pre-flight

From the repository root:

```powershell
# 1. Install the AI service
cd services/ai
python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -e ".[dev]"

# 2. Confirm tests pass
.venv\Scripts\python.exe -m pytest -q
# Expected: 42+ passed, 1 skipped (live NVIDIA opt-in)

# 3. Build and seed the SpacetimeDB backend
cd ..\..
npm run setup
$env:SPACETIME_CLI = "$env:LOCALAPPDATA\SpacetimeDB-2.14.1\spacetimedb-cli.exe"
& $env:SPACETIME_CLI start --listen-addr 127.0.0.1:3000 --in-memory
npm run build
npm run seed:demo   # writes .demo/demo-accounts.json (git-ignored)

# 4. Start the AI service in scripted mode
cd services\ai
$env:AI_ENVIRONMENT = "development"
$env:AI_PROVIDER_MODE = "scripted"
$env:AI_BACKEND_SERVICE_TOKEN = "<service-principal token from seed-demo>"
$env:AI_STDB_DB_NAME = "sentinelzero"
# AI_BACKEND_BASE_URL defaults to http://127.0.0.1:3000
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

---

## Key demo beats

### 1. Truthful Nemotron labeling

`GET /health` reports:

```json
{
  "inference_mode": "SIMULATED",
  "inference_label": "SIMULATED_MODEL_OUTPUT",
  "provider": {
    "mode": "scripted",
    "endpoint_class": "SIMULATED_SCRIPTED",
    "live_inference_available": false
  }
}
```

Every run record carries `inference_mode` and a `truthfulness` block. Never claim `LIVE` without a real key.

### 2. Bounded tool trace

The agent console shows sanitized tool events (name, input summary, result IDs, timing, status) — never private model reasoning or raw provider bodies.

### 3. Human approval

`POST /v1/incidents/{id}/analyze` returns `202` with a run ID. The agent submits a `PENDING` recommendation through `agent_submit_recommendation`. The AI service has **no approve/execute endpoint**. A human COMMANDER calls `approve_recommendation` in SpacetimeDB, which atomically creates exactly one task (`idempotencyKey = rec:<id>`).

### 4. Outage independence

SentinelZero's host (UI, API, identity, DB) is separately administered from the simulated compromised corporate network. A corporate-network outage does not take SentinelZero offline.

---

## Fallback when NVIDIA is unreachable

If `NVIDIA_API_KEY` is unavailable or the NVIDIA endpoint is unreachable:

1. Run with `AI_PROVIDER_MODE=scripted` (deterministic, labeled `SIMULATED`).
2. The demo proceeds identically; only the inference label changes.
3. Do **not** silently fall back to a mock and describe it as live.

---

## Verified vs unverified claims

| Claim | Status |
|---|---|
| Authenticated API with tenant/role checks | Verified (pytest) |
| Read-only tool allowlist, no destructive tools | Verified (pytest) |
| Evidence-linked structured recommendations | Verified (pytest) |
| Bounded steps, tool calls, context, cancellation | Verified (pytest) |
| PENDING-only proposal submission | Verified (pytest) |
| Real SpacetimeDB backend integration | Implemented, contract-frozen |
| Live NVIDIA Nemotron inference | **Blocked** — no API key available |
| Multi-session live updates | Verified (SpacetimeDB views) |
| Browser → AI service integration | Mock in web; contract defined |
