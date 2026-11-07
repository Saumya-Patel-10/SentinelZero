# SentinelZero AI Service — Demo Script

Audience: interviewer, reviewer, or teammate. Duration: **8–10 minutes**.
Everything here uses synthetic hospital data and, by default, a **scripted
provider**. That is intentional: it makes the demo deterministic and it is labeled
honestly everywhere.

> **Do not claim live NVIDIA inference during the scripted demo.** The service
> says `SIMULATED_MODEL_OUTPUT`, and the evidence artifacts are labeled the same
> way. A live-mode section is included at the end, but it is only valid if the
> live pytest passes with your own `NVIDIA_API_KEY`.

---

## Pre-flight (do this before the audience joins)

From the repository root:

```powershell
cd C:\Data\Saumya\AI-Projects\SentinelZero-agent03

# Service environment (once)
cd services\ai
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
cd ..\..

# Confirm tests and simulator before demoing
cd services\ai
.\.venv\Scripts\python.exe -m pytest -q
cd ..\..
python -m simulator verify
```

Expected: `115 passed, 1 skipped` and simulator `"ok": true`.

Keep two terminals open:

- **Terminal A** — repository root, for `python -m simulator ...`.
- **Terminal B** — `services/ai`, for the service and API calls.

---

## Timing plan

| Time | Segment |
|---|---|
| 0:00 | Frame the problem and the safety boundary |
| 0:45 | Seed the deterministic exercise |
| 1:45 | Show truthful health labels |
| 2:30 | Mint a scoped demo token |
| 3:00 | Start analysis |
| 3:30 | Inspect the bounded run and tool calls |
| 5:00 | Read the evidence-linked recommendation |
| 6:15 | Submit as pending human approval |
| 7:00 | Safety negatives (auth, tenant, no approval endpoint) |
| 8:00 | Close: verified vs not verified |
| 8:30 | Optional live NVIDIA mode |

---

## 0:00 — Frame it (45 s)

Say:

> "SentinelZero is an incident-response console. This service is the AI analyst.
> It can read authorized incident context and propose tasks with citations. It
> cannot approve, assign, isolate, or execute anything. Every proposal stops at
> `PENDING_HUMAN_APPROVAL`, and the human commander stays in the operational
> backend. Today's data is a synthetic hospital ransomware exercise."

Show the run record's `truthfulness` block later to reinforce this.

Do **not** say the model is currently analyzing live hospital data or making
decisions.

---

## 0:45 — Seed the deterministic exercise

**Terminal A** (repository root):

```powershell
python -m simulator run
python -m simulator status
```

Expected (abridged):

```json
{
  "ok": true,
  "phase": "injected",
  "scenario_id": "hospital_ransomware_v1",
  "exercise_label": "EXERCISE",
  "exfiltration_status": ["UNKNOWN"],
  "state_sha256": "6aad55610eb74e8744b0f137c6f58a7af6f1750ca5ff316d82d582d133ee4d5c",
  "counts": {
    "assets": 12,
    "service_dependencies": 8,
    "services": 3,
    "operational_impacts": 3,
    "tasks": 6,
    "evidence_references": 12
  }
}
```

Say:

> "The state is rebuilt deterministically. The SHA-256 is stable, every identity
> uses the reserved `.invalid` domain, and every record is labeled EXERCISE.
> Exfiltration stays UNKNOWN — the scenario does not let the AI invent a breach."

Point out the invariant: scheduling is `CONFIRMED` unavailable, EHR database
compromise is `SUSPECTED`, not confirmed.

---

## 1:45 — Start the service and show truthful labels

**Terminal B** (`services/ai`):

```powershell
$env:AI_ENVIRONMENT = "development"
$env:AI_PROVIDER_MODE = "scripted"
$env:AI_BACKEND_MODE = "memory"
$env:AI_JWT_SECRET = python -c "import secrets; print(secrets.token_urlsafe(48))"
$env:AI_SIMULATOR_STATE_PATH = "$PWD\..\..\simulator\.state\state.json"
$env:AI_RATE_LIMIT_PER_MINUTE = "30"
$env:AI_RATE_LIMIT_BURST = "10"

.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Leave it running. In a third terminal (or a split), call:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" | ConvertTo-Json -Depth 8
```

Expected highlights:

```json
{
  "status": "ok",
  "checks": {
    "auth_configured": true,
    "provider_configured": true,
    "backend_ready": true
  },
  "provider": {
    "mode": "scripted",
    "endpoint_class": "SIMULATED_SCRIPTED",
    "inference_label": "SIMULATED_MODEL_OUTPUT",
    "live_inference_available": false
  },
  "backend": {
    "mode": "memory",
    "contract_version": "MOCK-1",
    "contract_status": "MOCK_AWAITING_AGENT1"
  },
  "proposal_only": true,
  "secrets_exposed": false
}
```

Say:

> "The health endpoint advertises exactly what this is: scripted output, a mock
> backend, no live inference, no secrets. If I configured a real NVIDIA key and an
> NVIDIA host, this label would change to `LIVE_NVIDIA_INFERENCE` only then."

---

## 2:30 — Mint a caller token

The service never mints tokens at runtime. This helper is for local demo use and
matches the auth claims shape.

```powershell
$TOKEN = .\.venv\Scripts\python.exe -c "from app.auth import mint_test_token; import os; print(mint_test_token(secret=os.environ['AI_JWT_SECRET'], subject='analyst@riverbend.exercise.invalid', organization_id='org_riverbend_001', roles=['ANALYST']))"
$H = @{ Authorization = "Bearer $TOKEN" }
$TOKEN.Substring(0, 24) + "..."
```

Say:

> "The caller is an analyst in the Riverbend exercise organization. The service
> verifies signature, issuer, audience, expiry, and then re-checks membership and
> role against the incident backend. A forged role in the token is not enough."

---

## 3:00 — Start analysis

```powershell
$accepted = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8000/v1/incidents/inc_riverbend_ransomware_001/analyze" `
  -Headers $H -ContentType "application/json" `
  -Body '{"focus":"Preserve uncertainty about exfiltration and avoid duplicate tasks."}'

$accepted | ConvertTo-Json -Depth 6
```

Expected: HTTP 202 with:

```json
{
  "run_id": "run_...",
  "status": "QUEUED",
  "incident_id": "inc_riverbend_ransomware_001",
  "provider_mode": "scripted",
  "inference_label": "SIMULATED_MODEL_OUTPUT",
  "live_inference": false,
  "exercise_label": "EXERCISE",
  "notice": "SIMULATED model output (not live inference). Proposals require human approval."
}
```

Say:

> "Analysis is asynchronous. The run is bounded: max steps, max tool calls,
> context size, wall-clock deadline, body size, and per-user concurrency."

---

## 3:30 — Inspect the bounded run

```powershell
$run = $null
for ($i = 0; $i -lt 40; $i++) {
  $run = Invoke-RestMethod -Uri "http://127.0.0.1:8000/v1/agent-runs/$($accepted.run_id)" -Headers $H
  if ($run.status -in @('COMPLETED','FAILED','CANCELLED')) { break }
  Start-Sleep -Milliseconds 250
}

$run.status
$run.truthfulness | ConvertTo-Json -Depth 5
$run.tool_calls | Select-Object tool_name, status, duration_ms | Format-Table
$run.provider_calls | Select-Object step, model_identifier, status, finish_reason, tool_calls | Format-Table
```

Expected: `COMPLETED`, two provider turns, five read-only tool calls:

```
get_incident
get_assets
get_dependencies
get_open_tasks
get_evidence_summaries
```

Say:

> "The model had to use tools before it could answer. There is no shell, no
> database write, no approval, and no incident-id argument. Scope is injected
> server-side. The tool results are bounded and redacted before they go back to
> the model."

Point at `provider_calls`: turn 1 is `tool_calls`; turn 2 is the structured
recommendation.

---

## 5:00 — Read the recommendation

```powershell
$rec = $run.recommendation
$rec.summary
$rec.approval_status
$rec.evidence_ids_used
$rec.facts | Select-Object statement, verification_status, confidence | Format-List
$rec.uncertainties | Select-Object question, why_unknown, resolution_step | Format-List
$rec.proposed_tasks | Select-Object title, priority, evidence_basis, requires_human_approval | Format-Table
```

Say:

> "Every fact cites evidence ids that the evidence tool actually returned. If the
> model fabricates an id, the run fails validation rather than showing the
> citation. Tasks marked `EVIDENCE_BACKED` must carry evidence. The exfiltration
> question stays explicitly unknown, with a resolution step. And every task has
> `requires_human_approval: true` because the schema makes `false` impossible."

If asked why the summary says `SIMULATED ANALYST OUTPUT`: that is the honest
label. It is a deterministic test double, not a live model.

---

## 6:15 — Submit as pending human approval

```powershell
$submitUrl = "http://127.0.0.1:8000/v1/recommendations/$($rec.recommendation_id)/submit"

Invoke-RestMethod -Method Post -Uri $submitUrl `
  -Headers ($H + @{ "Idempotency-Key" = "demo-001" }) | ConvertTo-Json -Depth 6

# Repeat with a different key: still returns the recorded submission as a duplicate.
Invoke-RestMethod -Method Post -Uri $submitUrl `
  -Headers ($H + @{ "Idempotency-Key" = "demo-002" }) | ConvertTo-Json -Depth 6
```

Expected:

```json
{
  "approval_status": "PENDING_HUMAN_APPROVAL",
  "submitted": true,
  "duplicate": false,
  "backend_reference": "mock-submission-..."
}
```

Second call: `"duplicate": true`.

Say:

> "Submission records a proposal. It does not approve it. There is no approve or
> execute endpoint in this service — approval lives in the operational backend
> with a human commander."

---

## 7:00 — Safety negatives

**No token (401):**

```powershell
try {
  Invoke-RestMethod -Method Post `
    -Uri "http://127.0.0.1:8000/v1/incidents/inc_riverbend_ransomware_001/analyze" `
    -ContentType "application/json" -Body "{}"
} catch {
  $_.ErrorDetails.Message | ConvertFrom-Json | ConvertTo-Json -Depth 5
}
```

Expected: `error.code = "AUTH_REQUIRED"`, generated `request_id`.

**Wrong tenant (403):**

```powershell
$OTHER = .\.venv\Scripts\python.exe -c "from app.auth import mint_test_token; import os; print(mint_test_token(secret=os.environ['AI_JWT_SECRET'], subject='analyst@riverbend.exercise.invalid', organization_id='org_other_001', roles=['ANALYST']))"
try {
  Invoke-RestMethod -Method Post `
    -Uri "http://127.0.0.1:8000/v1/incidents/inc_riverbend_ransomware_001/analyze" `
    -Headers @{ Authorization = "Bearer $OTHER" } -ContentType "application/json" -Body "{}"
} catch {
  $_.ErrorDetails.Message | ConvertFrom-Json | ConvertTo-Json -Depth 5
}
```

Expected: `error.code = "ACCESS_DENIED"`; the response does not reveal whether
the incident exists elsewhere.

**No approval endpoint (404):**

```powershell
try {
  Invoke-RestMethod -Method Post `
    -Uri "http://127.0.0.1:8000/v1/recommendations/$($rec.recommendation_id)/approve" `
    -Headers $H
} catch {
  $_.ErrorDetails.Message
}
```

Expected: safe `NOT_FOUND` envelope, not an approval action.

**Unknown run (404):**

```powershell
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:8000/v1/agent-runs/run_does_not_exist" -Headers $H
} catch {
  $_.ErrorDetails.Message | ConvertFrom-Json | ConvertTo-Json -Depth 5
}
```

---

## 8:00 — Close with verified vs unverified

Say:

> "What is verified today: the authenticated API, tenant and role checks, the
> read-only allowlist, schema and evidence validation, bounds, cancellation,
> redaction, and the OpenAI-compatible tool round trip at the wire level. The
> pytest suite is 115 passing with one opt-in live test skipped, and Playwright API
> smoke is 4 passing. What is **not** verified: live Nemotron inference and model
> quality, because there is no NVIDIA key in this environment. The backend contract
> with Agent 1 is MOCK-1, and the run store is in-memory. Those are documented
> limits, not hidden assumptions."

Show the evidence files if useful:

```powershell
Get-Content .\evidence\tool-roundtrip-simulated.json | ConvertFrom-Json |
  Select-Object label, live_inference, @{n='assertions_passed';e={($_.assertions.PSObject.Properties.Value -eq $true).Count}}
```

Expected: `SIMULATED_MODEL_OUTPUT`, `live_inference: false`, 16 assertions true.

---

## 8:30 — Optional live NVIDIA mode

Only do this with a real key you are allowed to spend against. Stop the scripted
service first (`Ctrl+C` in Terminal B), then:

```powershell
$env:AI_PROVIDER_MODE = "live"
$env:NVIDIA_API_KEY = "nvapi-..."
$env:AI_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b"
$env:AI_BACKEND_MODE = "memory"
$env:AI_SIMULATOR_STATE_PATH = "$PWD\..\..\simulator\.state\state.json"
$env:AI_JWT_SECRET = python -c "import secrets; print(secrets.token_urlsafe(48))"

.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Check `GET /health` first:

- `provider.inference_label` must be `LIVE_NVIDIA_INFERENCE`.
- If it says `UNVERIFIED_PROVIDER`, the configured base URL is not an NVIDIA host.
- If `provider_configured` is false, the key is missing.

Then run the live test before claiming anything:

```powershell
$env:AI_LIVE_TESTS = "1"
.\.venv\Scripts\python.exe -m pytest -m live -q
```

If it passes, you may say live inference is verified for that model, endpoint,
account, and date. If it fails, report the observed failure category and fall back
to the scripted demo; do not call the run live NVIDIA inference.

`/health` and every run record carry the label, so the audience can check the
claim rather than trusting the narration.

---

## Teardown

```powershell
# Stop uvicorn with Ctrl+C, then optionally reset the exercise
cd C:\Data\Saumya\AI-Projects\SentinelZero-agent03
python -m simulator reset
```

The run store is in-memory; restarting the service clears all runs and
submissions. That is expected for this branch.

---

## Fallbacks

| Problem | Action |
|---|---|
| `503 AI_BACKEND_NOT_READY` | Run `python -m simulator run` from the repo root. |
| `503 AI_PROVIDER_NOT_CONFIGURED` | Live mode selected without `NVIDIA_API_KEY`; use scripted mode. |
| `429 RATE_LIMITED` | Restart the service with higher `AI_RATE_LIMIT_PER_MINUTE` / `AI_RATE_LIMIT_BURST`, or wait a minute. |
| Run `FAILED` with `AI_OUTPUT_INVALID` | The result failed schema/evidence validation. Show the failure honestly; do not hand-edit the payload. |
| Port already in use | Change `--port 8000` and the URLs, or stop the other process. |
| Token rejected | Ensure `AI_JWT_SECRET` is the same value used to mint the token and that the token has not expired. |

---

## One-sentence summary to leave with the audience

> "A bounded, authenticated AI analyst that can read authorized incident context
> and propose evidence-linked tasks, but cannot approve or execute anything — with
> every simulated or live label exposed in the API."
