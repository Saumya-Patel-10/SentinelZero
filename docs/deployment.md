# SentinelZero AI Service — Deployment Guide

Status date: **2026-11-07**. Branch: `agent/03-ai-demo-qa`.

This guide describes how to run the authenticated, proposal-only AI service, what is
actually verified, and what must be completed before production use.

> **Truthfulness:** the service has been exercised with a local NVIDIA
> OpenAI-compatible wire test double and synthetic hospital data. **Live NVIDIA
> inference was not executed in this environment because no `NVIDIA_API_KEY` was
> available.** Do not claim live inference until the live test in
> [Live NVIDIA verification](#live-nvidia-verification) passes.

---

## 1. What is in this service

| Component | Location | Status |
|---|---|---|
| FastAPI app, auth, middleware | `services/ai/app/` | Implemented, tested |
| NVIDIA Nemotron client | `app/llm/nemotron_client.py` | Protocol implemented; live call unverified |
| Bounded tool-use agent | `app/agents/incident_agent.py` | Implemented, tested with wire double |
| Tool allowlist | `app/tools/specs.py` | Five read-only tools + proposal tool, exact allowlist |
| Pydantic evidence-linked schemas | `app/schemas.py` | Implemented, tested |
| Auth + incident authorization | `app/auth.py`, `app/backend.py` | Implemented, tested (MOCK backend) |
| In-memory run store | `app/store.py` | Implemented; not durable |
| Simulator | `simulator/` | Deterministic, verified |
| pytest suite | `services/ai/tests/` | 115 passed, 1 skipped |
| Playwright API smoke | `services/ai/tests/e2e/` | 4 passed |
| Performance measurement | `services/ai/tests/performance/` | Scripted service overhead only |

The AI service **cannot approve, execute, assign, isolate, delete, message, or
transition incident state**. It can read authorized incident context and record
proposals that remain `PENDING_HUMAN_APPROVAL`.

---

## 2. Architecture

```
Browser / operator
      │  JWT (HS256 demo, RS256 production)
      ▼
┌──────────────────────────────┐
│ SentinelZero AI (FastAPI)    │
│  auth → authz → rate limit   │
│  bounded agent loop          │
│    read-only tools ──────────┼──► Agent 1 backend / simulator state
│    NVIDIA chat completions ──┼──► https://integrate.api.nvidia.com/v1
│    schema + evidence checks  │
│  in-memory run store         │
└──────────────────────────────┘
      │ pending proposal
      ▼
Human commander in the operational backend (out of scope here)
```

Key invariants:

- Caller identity, organization, and role come only from the verified JWT.
- Incident scope is checked by the backend on analyze, read, cancel, tool, and submit.
- The model receives no credentials, approval capability, or action tool.
- Every run records `provider_mode` and `inference_label`.
- Scripted output is always `SIMULATED_MODEL_OUTPUT`; only a configured NVIDIA
  host can produce `LIVE_NVIDIA_INFERENCE`.

---

## 3. Prerequisites

- Python **3.12+** (tested with 3.12.10).
- Optional: Node.js 20+ for Playwright.
- Optional live inference: an NVIDIA API key with access to the selected model.
- No SpacetimeDB or Agent 1 backend is required for the simulator/MOCK demo.

---

## 4. Install

From the repository root:

```powershell
cd services/ai
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

For the simulator commands, run from the repository root:

```powershell
python -m simulator run
python -m simulator verify
python -m simulator status
```

`simulator/.state/state.json` is generated and gitignored. The injected state has a
deterministic SHA-256 of
`6aad55610eb74e8744b0f137c6f58a7af6f1750ca5ff316d82d582d133ee4d5c`.

---

## 5. Configuration

Copy `services/ai/.env.example` to `services/ai/.env` (gitignored). Never commit a
real `.env` or API key.

All settings use the `AI_` prefix. The NVIDIA key and JWT secret also accept the
unprefixed names `NVIDIA_API_KEY` and `JWT_SECRET` for compatibility.

### Required for every deployment

| Variable | Purpose |
|---|---|
| `AI_JWT_SECRET` **or** `AI_JWT_PUBLIC_KEY` | Verify caller tokens. HS256 needs ≥32 random bytes; RS256 needs a PEM public key. |
| `AI_JWT_ISSUER` | Expected `iss` (default `sentinelzero-auth`). |
| `AI_JWT_AUDIENCE` | Expected `aud` (default `sentinelzero-ai`). |
| `AI_BACKEND_MODE` | `memory` for simulator; `http` for the Agent 1 contract. |

### NVIDIA

| Variable | Default | Notes |
|---|---|---|
| `AI_NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Base URL; `/chat/completions` is appended. A full URL ending in `/chat/completions` is normalized. |
| `AI_NVIDIA_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Configurable; must be a model your key can access. |
| `NVIDIA_API_KEY` | unset | Server-side only. Never expose to the browser. |
| `AI_PROVIDER_MODE` | `live` | `scripted` is for offline demo/test only and is refused in production. |
| `AI_NVIDIA_TIMEOUT_SECONDS` | `45` | Per-request timeout. |
| `AI_NVIDIA_MAX_RETRIES` | `2` | Retries for timeout/429/5xx. |
| `AI_NVIDIA_MAX_OUTPUT_TOKENS` | `2048` | Bound on model output. |
| `AI_NVIDIA_ENABLE_THINKING` | `false` | Adds `chat_template_kwargs.enable_thinking` if the selected model needs it. |
| `AI_NVIDIA_FORCE_NONEMPTY_CONTENT` | `false` | Adds `chat_template_kwargs.force_nonempty_content` if needed. |

### Bounds and storage

| Variable | Default |
|---|---|
| `AI_MAX_STEPS` | `6` (1–8) |
| `AI_MAX_TOOL_CALLS` | `10` (1–16) |
| `AI_MAX_TOOL_RESULT_CHARS` | `20000` |
| `AI_MAX_CONTEXT_CHARS` | `32000` |
| `AI_RUN_DEADLINE_SECONDS` | `90` (5–300) |
| `AI_MAX_BODY_BYTES` | `16384` |
| `AI_MAX_CONCURRENT_RUNS_PER_USER` | `2` |
| `AI_RATE_LIMIT_PER_MINUTE` | `6` |
| `AI_RATE_LIMIT_BURST` | `2` |
| `AI_RUN_TTL_SECONDS` | `3600` |
| `AI_MAX_STORED_RUNS` | `500` |

### Production validation

`Settings` refuses to start in `AI_ENVIRONMENT=production` if:

- `AI_PROVIDER_MODE=scripted`;
- neither a JWT secret nor public key is configured;
- `AI_BACKEND_MODE=http` without `AI_BACKEND_SERVICE_TOKEN`;
- CORS contains `*`.

---

## 6. Run the service

### Offline, scripted demo (recommended for the interview demo)

From `services/ai`:

```powershell
$env:AI_ENVIRONMENT = "development"
$env:AI_PROVIDER_MODE = "scripted"
$env:AI_BACKEND_MODE = "memory"
$env:AI_JWT_SECRET = "$(python -c "import secrets; print(secrets.token_urlsafe(48))")"
$env:AI_SIMULATOR_STATE_PATH = "$PWD\..\..\simulator\.state\state.json"

# Seed the synthetic exercise first (from the repo root)
python -m simulator run

.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### Live Nemotron mode

```powershell
$env:AI_PROVIDER_MODE = "live"
$env:NVIDIA_API_KEY = "nvapi-..."
$env:AI_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b"
$env:AI_JWT_SECRET = "..."
$env:AI_BACKEND_MODE = "memory"
$env:AI_SIMULATOR_STATE_PATH = "$PWD\..\..\simulator\.state\state.json"

.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`GET /health` reports `provider.inference_label=LIVE_NVIDIA_INFERENCE` only when a
key is configured and the endpoint host is an NVIDIA host. A custom
OpenAI-compatible endpoint is labeled `UNVERIFIED_PROVIDER` and is never described
as live NVIDIA inference.

### Mint a demo token

The service does not mint tokens at runtime. This helper is for local tests/demos
only and uses the same HS256 claims as the auth service:

```powershell
cd services/ai
$env:AI_JWT_SECRET = "the-same-secret-the-service-uses"
.\.venv\Scripts\python.exe -c "from app.auth import mint_test_token; import os; print(mint_test_token(secret=os.environ['AI_JWT_SECRET'], subject='analyst@riverbend.exercise.invalid', organization_id='org_riverbend_001', roles=['ANALYST']))"
```

Required claims: `sub`, `org_id`, `roles`, `iss`, `aud`, `iat`, `exp`. Authorization
is re-checked against the incident backend's membership record, so a forged role
claim does not grant incident access.

### Analyze, poll, submit

```powershell
$TOKEN = "<paste-token>"
$H = @{ Authorization = "Bearer $TOKEN" }

$accepted = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8000/v1/incidents/inc_riverbend_ransomware_001/analyze" `
  -Headers $H -ContentType "application/json" -Body "{}"

$accepted | ConvertTo-Json -Depth 6
$run = Invoke-RestMethod -Uri "http://127.0.0.1:8000/v1/agent-runs/$($accepted.run_id)" -Headers $H
$run | ConvertTo-Json -Depth 12

$rec = $run.recommendation.recommendation_id
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8000/v1/recommendations/$rec/submit" `
  -Headers ($H + @{ "Idempotency-Key" = "demo-001" }) | ConvertTo-Json -Depth 6
```

The submit response is always `approval_status=PENDING_HUMAN_APPROVAL`. There is no
approve/execute endpoint in this service.

---

## 7. NVIDIA Nemotron protocol verification

Verified against NVIDIA's OpenAI-compatible documentation (2026-11) and exercised
at the wire level with `httpx.MockTransport`:

- `POST {AI_NVIDIA_BASE_URL}/chat/completions`
- Bearer authentication with `NVIDIA_API_KEY`
- Request body: `model`, `messages`, `tools`, `tool_choice="auto"`,
  `parallel_tool_calls=true`, `temperature`, `top_p`, `max_tokens`, `stream=false`
- Second turn adds `response_format={"type":"json_schema", ...}`
- Assistant response may contain `tool_calls`; the service appends the assistant
  message and one `role="tool"` message per call with the matching `tool_call_id`
- HTTP mapping: `401/403` → auth failure; `429` → rate limited with `Retry-After`;
  `408/409/425/5xx` → retryable unavailable; `400` on `response_format` → retry once
  without a response format; malformed JSON/choices/tool calls → protocol error.

The exact request/response shapes are captured in
`services/ai/evidence/tool-roundtrip-simulated.json` (clearly labeled simulated).

### Live NVIDIA verification

This is the only test that contacts NVIDIA. It requires both a key and an explicit
opt-in:

```powershell
cd services/ai
$env:NVIDIA_API_KEY = "nvapi-..."
$env:AI_LIVE_TESTS = "1"
$env:AI_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b"
.\.venv\Scripts\python.exe -m pytest -m live -q
```

The live test runs one full analyze workflow and requires: HTTP 202, a completed
run, at least one read-only tool call, a schema-valid recommendation, and
`PENDING_HUMAN_APPROVAL`. If it fails, record the failure category from the run
instead of claiming live verification.

**Current result:** skipped — `NVIDIA_API_KEY` is not present in this environment.
Live model availability and tool-calling quality remain unverified.

---

## 8. Agent 1 backend contract (MOCK-1, not frozen)

Agent 1 has not published a frozen backend contract in this branch. The AI service
uses `MemoryBackendClient` against the simulator state. `HttpBackendClient` is a
proposed, **unverified** implementation. Replace paths only after the contract is
frozen; do not silently reinterpret it.

Service authentication header: `X-Sentinel-Service-Token`.

| Operation | Proposed endpoint |
|---|---|
| Readiness | `GET /internal/v1/ready` |
| Authorize | `POST /internal/v1/authorize` with `{subject, organization_id, incident_id, action}` → `{allowed, role, incident?}` |
| Incident | `GET /internal/v1/incidents/{incident_id}` |
| Assets | `GET /internal/v1/incidents/{incident_id}/assets` |
| Dependencies | `GET /internal/v1/incidents/{incident_id}/dependencies` → `{dependencies, services, impacts, data_scopes}` |
| Open tasks | `GET /internal/v1/incidents/{incident_id}/tasks?status=open` |
| Evidence summaries | `GET /internal/v1/incidents/{incident_id}/evidence/summaries` |
| Submit pending recommendation | `POST /internal/v1/incidents/{incident_id}/recommendations`; request `approval_status` must be `PENDING_HUMAN_APPROVAL`; response must include `reference` or `id` |

Reducers required from Agent 1: `create_agent_run`, `record_agent_result`,
`create_task`, `approve_task`. The AI service must **never** call `approve_task`,
`reject_task`, `transition_incident_status`, `update_task_status`,
`update_asset_status`, `update_data_scope`, `send_message`, or `revoke_member`.

Full declarations: `simulator/contract.py`.

---

## 9. Production checklist

Before claiming production readiness:

1. **Persistence:** replace the in-memory `RunStore` with the canonical
   `AgentRun`/`AgentToolCall` storage in Agent 1. Runs are lost on restart today.
2. **Distributed limits:** the rate limiter and per-user concurrency limiter are
   process-local. Use a shared limiter and either one worker or sticky routing.
3. **Auth:** use RS256 with a published public key or a rotated shared secret. Add
   token revocation/`jti` replay protection at the issuer.
4. **TLS and network policy:** terminate TLS in front of the service and allow
   egress only to the configured NVIDIA endpoint (and the backend, if HTTP mode).
5. **Secrets:** inject `NVIDIA_API_KEY`, JWT material, and the backend service token
   from a secret manager. Never bake them into images or frontend bundles.
6. **CORS:** set an explicit origin list; wildcard is refused in production.
7. **Docs:** `AI_ENABLE_DOCS=false` (docs are automatically disabled in production).
8. **Observability:** ship the structured logs (they are redacted), scrape
   `/health`, and add metrics/alerts for provider errors, run failures, and latency.
   Prompts and raw provider bodies are intentionally not stored.
9. **Live verification:** run the live pytest and preserve the output with the
   release. Re-run when the model ID, endpoint, or provider account changes.
10. **Human approval:** keep approval in the operational backend. This service must
    never receive an approval capability.

---

## 10. Operational behavior

- `POST /v1/incidents/{id}/analyze` → `202` with `run_id` and truthfulness labels.
- `GET /v1/agent-runs/{run_id}` → bounded run record, tool/provider call summaries,
  and the pending recommendation.
- `POST /v1/agent-runs/{run_id}/cancel` → `202`; terminal runs return `409`.
- `POST /v1/recommendations/{id}/submit` → `202`; repeats are idempotent duplicates.
- Errors use `{"error":{"code","message","request_id","details"}}`; provider bodies,
  prompts, stack traces, and secrets are never returned.
- All responses include `X-Request-ID`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`.
- Request bodies are bounded before authentication; oversized bodies return `413`.

Log redaction covers bearer tokens, `nvapi-` keys, and common key/value forms. Tool
results are redacted for email, SSN, MRN, phone, DOB, API tokens, and bearer tokens
before they are sent to the model.

---

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/health` `status=degraded`, provider not configured | `NVIDIA_API_KEY` missing in live mode. This is expected for the scripted demo. |
| Analyze returns `503 AI_PROVIDER_NOT_CONFIGURED` | Live provider selected without a key. Set the key or use `AI_PROVIDER_MODE=scripted` for the demo. |
| Analyze returns `403 ACCESS_DENIED` | Token organization does not match the incident, membership is revoked, or the member role is not allowed for `ai.analyze`. |
| Run `FAILED` with `AI_TOOL_USE_REQUIRED` | The model did not call a read-only tool. The service requires a tool round trip. |
| Run `FAILED` with `AI_OUTPUT_INVALID` | Model output was not schema-valid or cited an evidence id not returned by the evidence tool. |
| Run `FAILED` with `AI_PROVIDER_*` | Provider timeout/auth/rate limit/protocol failure; see `error_category` and `provider_calls`. |
| `413 PAYLOAD_TOO_LARGE` | Request body exceeded `AI_MAX_BODY_BYTES`. |
| `429 RATE_LIMITED` | Per-minute budget or per-user concurrent-run limit reached. |

---

## 12. Test commands

```powershell
cd services/ai

# Unit + integration (scripted and wire-double); live test is skipped
.\.venv\Scripts\python.exe -m pytest -q

# Only the live NVIDIA test (requires key + opt-in)
$env:NVIDIA_API_KEY = "nvapi-..."
$env:AI_LIVE_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -m live -q

# Wire evidence artifact (simulated)
.\.venv\Scripts\python.exe scripts\generate_evidence.py

# Scripted service-overhead measurement
.\.venv\Scripts\python.exe tests\performance\measure_latency.py --runs 10

# Playwright API smoke (starts the scripted service)
cd tests\e2e
npm install
$env:AI_E2E_PYTHON = "C:\path\to\services\ai\.venv\Scripts\python.exe"
npm run test:api
```

See `docs/testing.md` for the recorded results and `docs/limitations.md` for
known gaps.
