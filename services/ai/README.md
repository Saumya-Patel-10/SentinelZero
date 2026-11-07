# SentinelZero AI Service

Authenticated, **proposal-only** incident analysis for SentinelZero using NVIDIA
Nemotron tool calling. The service reads authorized incident context through a
small read-only tool allowlist, asks the model for an evidence-linked
recommendation, validates the result, and submits it as
`PENDING_HUMAN_APPROVAL`.

> **Truthfulness:** this branch was exercised with a deterministic scripted
> provider and a local NVIDIA-compatible wire test double. **Live NVIDIA inference
> has not been run because no `NVIDIA_API_KEY` was available.** Do not describe a
> scripted run as live inference. See [`docs/limitations.md`](../../docs/limitations.md).

---

## What this service can and cannot do

**Can**

- Authenticate a caller from a verified JWT and authorize the incident through the
  incident backend.
- Read incident header, assets, dependencies/impacts, open tasks, and evidence
  metadata through five read-only tools.
- Produce schema-validated facts, uncertainties, and task proposals that cite
  evidence ids returned by the evidence tool.
- Record a pending submission with an idempotent reference.
- Bound steps, tool calls, context, body size, concurrency, and runtime.

**Cannot**

- Approve, reject, assign, execute, isolate, disable, delete, message, or change
  incident/asset/task status.
- Accept an `incident_id` as a tool argument (scope is injected server-side).
- Return prompts, raw provider bodies, stack traces, API keys, or JWT secrets.
- Act as a durable system of record. Runs live in memory and are lost on restart.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Readiness and truthful provider/backend labels. No auth, no secrets. |
| `POST` | `/v1/incidents/{incident_id}/analyze` | Start a bounded analysis run (`202`). |
| `GET` | `/v1/agent-runs/{run_id}` | Read run status, tool/provider calls, recommendation. |
| `POST` | `/v1/agent-runs/{run_id}/cancel` | Request cancellation (`202`; `409` if already terminal). |
| `POST` | `/v1/recommendations/{recommendation_id}/submit` | Submit a proposal as pending human approval. |

Interactive docs are available at `/docs` outside production. Errors always use:

```json
{"error":{"code":"...","message":"...","request_id":"...","details":{}}}
```

Security headers on every response: `X-Request-ID`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

---

## Quick start (offline scripted demo)

From the repository root:

```powershell
# 1. Install the service
cd services/ai
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"

# 2. Seed the synthetic hospital exercise
cd ..\..
python -m simulator run
python -m simulator verify

# 3. Start the service in scripted + memory mode
cd services/ai
$env:AI_ENVIRONMENT = "development"
$env:AI_PROVIDER_MODE = "scripted"
$env:AI_BACKEND_MODE = "memory"
$env:AI_JWT_SECRET = "$(python -c "import secrets; print(secrets.token_urlsafe(48))")"
$env:AI_SIMULATOR_STATE_PATH = "$PWD\..\..\simulator\.state\state.json"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Then mint a demo token and call the API. A full walkthrough with expected output
is in [`docs/demo-script.md`](../../docs/demo-script.md).

For live Nemotron mode, set `AI_PROVIDER_MODE=live` and `NVIDIA_API_KEY`. The
service reports `LIVE_NVIDIA_INFERENCE` only when a key is configured and the
endpoint is an NVIDIA host; any other OpenAI-compatible endpoint is labeled
`UNVERIFIED_PROVIDER`.

---

## Truthfulness labels

| Label | Meaning |
|---|---|
| `SIMULATED_MODEL_OUTPUT` | Scripted or wire-test-double output. Never live inference. |
| `LIVE_NVIDIA_INFERENCE` | A key is configured and the endpoint host is `nvidia.com`. |
| `UNVERIFIED_PROVIDER` | A key/endpoint is configured but it is not an NVIDIA host. |

Run records also expose `provider_mode`, `endpoint_class`, `exercise_label`, and a
`truthfulness` block (`proposal_only`, `live_inference`, `approval_required`).
`/health` reports `backend.contract_status` as `MOCK_AWAITING_AGENT1` while the
memory backend is in use.

---

## Configuration

Copy `.env.example` to `.env` (gitignored). All service variables use the `AI_`
prefix; `NVIDIA_API_KEY` and `JWT_SECRET` are accepted unprefixed for
compatibility.

Required for any deployment:

- `AI_JWT_SECRET` (HS256, 32+ random bytes) or `AI_JWT_PUBLIC_KEY` (RS256 PEM).
- `AI_JWT_ISSUER`, `AI_JWT_AUDIENCE`.
- `AI_BACKEND_MODE` (`memory` for the simulator, `http` for the Agent 1 contract).

Production startup refuses scripted mode, missing auth, wildcard CORS, and HTTP
backend mode without a service token.

The complete variable reference, bounds, and production checklist are in
[`docs/deployment.md`](../../docs/deployment.md).

---

## Layout

```
services/ai/
  app/
    main.py              FastAPI factory, error envelopes, docs gating
    config.py            Pydantic settings, secret handling, truthfulness labels
    auth.py              JWT verification and role checks
    middleware.py        request id, body limit, security headers
    backend.py           MemoryBackendClient (MOCK) + HttpBackendClient (MOCK-1)
    runtime.py           app lifecycle, provider selection, background runs
    store.py             bounded in-memory run store
    schemas.py           evidence-linked Pydantic contracts
    agents/              bounded tool-use loop
    llm/                 NVIDIA client, prompts, structured output, scripted provider
    tools/               exact read-only allowlist and proposal tool
    routes/              health, analyze/run status/cancel, submit
    security/            guardrails, redaction, rate limiting
  tests/                 pytest suites and Playwright E2E
  scripts/               simulated wire-evidence generator
  evidence/              recorded artifacts (clearly labeled)
```

---

## Security invariants

- Identity, organization, and roles come only from the verified JWT; body-supplied
  scope is ignored.
- Incident authorization is re-checked on analyze, every run read, cancel, and
  submit.
- Tool arguments are closed schemas. `propose_task` accepts no approval or status
  field, and `requires_human_approval` is `Literal[True]`.
- A final guard rejects any submission that is not `PENDING_HUMAN_APPROVAL`.
- Tool output is bounded and redacted (email, SSN, MRN, phone, DOB, tokens) before
  it reaches the model; prompt-injection markers are recorded.
- Request bodies are size-limited before authentication. Errors do not echo
  provider payloads or stack traces.

---

## Tests

```powershell
cd services/ai
.\.venv\Scripts\python.exe -m pytest -q
```

Recorded result on 2026-11-07: **115 passed, 1 skipped** in 2.46 s. The skip is
the opt-in live NVIDIA test. Playwright API smoke: **4 passed**. Details and
reproduction commands are in [`docs/testing.md`](../../docs/testing.md).

Live inference check (requires a key and explicit opt-in):

```powershell
$env:NVIDIA_API_KEY = "nvapi-..."
$env:AI_LIVE_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -m live -q
```

---

## Documentation

- [`docs/deployment.md`](../../docs/deployment.md) — configuration, NVIDIA protocol, MOCK-1 contract, production checklist.
- [`docs/demo-script.md`](../../docs/demo-script.md) — timed, copy-paste demo.
- [`docs/testing.md`](../../docs/testing.md) — test matrix and recorded results.
- [`docs/limitations.md`](../../docs/limitations.md) — verified vs unverified claims and closure criteria.
- [`simulator/README.md`](../../simulator/README.md) — deterministic synthetic exercise.
