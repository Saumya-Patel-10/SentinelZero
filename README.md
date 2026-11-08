# SentinelZero

Independent incident-command workspace for a cyber response that cannot trust the victim's directory, mail, or internal DNS.

The repository has three deployable parts. They are not one running system until you connect them.

| Part | What it is today |
|---|---|
| `packages/spacetime` | SpacetimeDB 2.14.1 module. Private tables, OIDC issuer allowlist, role checks, incident lifecycle, data-scope ledger, messages, tasks, and a per-organization SHA-256 audit chain. |
| `services/ai` | FastAPI service. Calls `nvidia/nemotron-3-super-120b-a12b` on `https://integrate.api.nvidia.com/v1` when a key is set. Default agent mode is four sequential specialists. Proposals stay `PENDING`. |
| `apps/web` | React command center. Without a configured host it runs an labeled exercise on in-memory fixtures. It does not log in and it does not open a SpacetimeDB session. |

Live NVIDIA inference is opt-in. A scripted provider exists for offline tests and is refused when `AI_ENVIRONMENT=production`.

## Architecture

```
Browser (exercise fixtures, or a future SpacetimeDB client)
        │  bearer token + run id
        ▼
FastAPI  ──verify_agent_run_access──►  SpacetimeDB (user token)
        │
        └── agent_claim_run / agent_get_* / agent_submit_recommendation
            / agent_complete_run                         (service principal)
        │
        └── chat/completions, stream=false
                    │
                    ▼
            NVIDIA integrate API
            nvidia/nemotron-3-super-120b-a12b
```

Orchestrated order is fixed: triage, impact, containment, communications, then deterministic synthesis. Synthesis is server code. It submits one `PENDING` recommendation. The model cannot approve, isolate, disable, or delete.

| Stage | Tools |
|---|---|
| Triage | `get_incident`, `get_evidence_summaries`, `query_threat_intelligence` |
| Impact | `get_assets`, `get_dependencies` |
| Containment | `get_open_tasks`, `propose_task` |
| Communications | none (draft sitrep only) |

`query_threat_intelligence` reads the public CISA Known Exploited Vulnerabilities JSON feed. A failed fetch returns `api_status=UNAVAILABLE` and an empty match list. It does not query MITRE ATT&CK and it does not present a local row as an authenticated lookup.

Incident text or tool output that matches a high-risk prompt-injection pattern aborts the run before a recommendation is submitted. Lower-risk patterns are labeled and treated as hostile data.

## Security boundaries

- Human authorization is `verify_agent_run_access` on SpacetimeDB. The AI service does not grant access from unverified JWT role claims.
- The service principal can read the claimed run and file a `PENDING` recommendation. It cannot approve.
- Issuer and audience policy is off until a platform admin adds a trusted issuer. An open server accepts host-minted tokens. Do not expose that mode.
- Module expiry checks bind HTTP calls. An open WebSocket is not cut when the identity-provider token expires. See `docs/SECURITY_MODEL.md`.
- The audit chain detects tampering when the client still holds an external pin. This repository does not anchor that pin, and it does not ship a backup.
- The web audit page is an exercise ledger. It does not verify the server chain.
- No production deployment or corporate-network isolation drill is included. The drill steps are in `docs/SECURITY_MODEL.md` section 8.

## Repository layout

```
apps/web              React command center
packages/shared       Roles, limits, audit-chain helpers, contracts
packages/spacetime    SpacetimeDB module, views, reducers, integration tests
services/ai           FastAPI agent
simulator             Synthetic hospital exercise for the AI simulator backend
docs                  Security model, integration contract, demo notes
```

## Requirements

- Node.js 20 or newer
- Python 3.12 (CI) or 3.11+
- SpacetimeDB CLI 2.14.1, only if you publish the module or run its integration tests

## Run the exercise console

```powershell
cd apps/web
pnpm install
pnpm test
pnpm dev
```

Open `http://localhost:5173`.

The top bar role control changes the local user. The status pill reads `EXERCISE REPLAY`. Analysis without an authenticated AI session is labeled `SIMULATED` and `EXERCISE SCENARIO`. The disconnect control is a UI state. Writes stay in the browser.

## Run the AI service

```powershell
cd services/ai
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
pytest -q
python -m simulator verify
```

From the repository root, `python -m simulator verify` checks the synthetic scenario file.

Offline tests use `AI_PROVIDER_MODE=scripted`. To call NVIDIA:

```powershell
$env:NVIDIA_API_KEY = "<key>"
$env:AI_PROVIDER_MODE = "live"
$env:AI_LIVE_TESTS = "1"
pytest -m live -q
```

The live test is skipped unless both the key and `AI_LIVE_TESTS=1` are set. Copy `services/ai/.env.example` before a manual run. `AI_BACKEND_MODE` is `spacetimedb` or `simulator`. `memory` is not a valid mode.

Production startup refuses a scripted provider, a simulator backend, a missing service token, and wildcard CORS.

## Run the SpacetimeDB module

Integration contract: `docs/INTEGRATION_CONTRACT.md`. Security model: `docs/SECURITY_MODEL.md`.

```powershell
npm run setup
npm run typecheck
npm run test:unit
```

Integration tests publish a throwaway database and need a local SpacetimeDB 2.14.1 server. They are not part of GitHub Actions today.

```powershell
npm run test:integration
```

## Continuous integration

`.github/workflows/ci.yml` on pull request runs Spacetime unit tests, the Python suite except live tests, the web Vitest suite, and `python -m simulator verify`.

The NVIDIA job runs only on a manual `workflow_dispatch`, and only if the `NVIDIA_API_KEY` secret is present. A green pull-request check is not evidence of a live model call.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` or `AI_NVIDIA_API_KEY` | AI service | Bearer token for the NVIDIA integrate API |
| `AI_NVIDIA_MODEL` | AI service | Default `nvidia/nemotron-3-super-120b-a12b` |
| `AI_PROVIDER_MODE` | AI service | `live` or `scripted` |
| `AI_AGENT_MODE` | AI service | `orchestrated` (default) or `single` |
| `AI_BACKEND_MODE` | AI service | `spacetimedb` or `simulator` |
| `AI_BACKEND_SERVICE_TOKEN` | AI service | Service principal for agent reducers |
| `VITE_AI_SERVICE_URL` | Web | Optional. Unused until an auth provider is installed in the client |

`apps/web` does not read `VITE_STDB_URI` or `VITE_OIDC_ISSUER` yet.

## Known limits

- The command center a judge clicks is the exercise UI. Server authorization is in the module, not in that browser session.
- Agent run state in FastAPI is in memory and ends when the process exits. The sitrep is included in the `agent_complete_run` summary so SpacetimeDB keeps a copy of the text.
- One recommendation is submitted per run. The commander approves it in SpacetimeDB, not in the AI service. `POST /v1/recommendations/{id}/submit` returns 404.
- `GET /v1/agent-runs/{id}` is the status route the browser polls.
- Evidence rows store a caller-supplied SHA-256. The module does not store file bytes and cannot prove the digest.
- There is no backup, restore path, or external audit anchor in this repository.

## License

MIT. See `LICENSE.txt`.
