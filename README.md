# SentinelZero

<div align="center">

```
  ███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗██╗     ███████╗███████╗██████╗  ██████╗ 
  ██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝██║     ╚══███╔╝██╔════╝██╔══██╗██╔═══██╗
  ███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗  ██║       ███╔╝ █████╗  ██████╔╝██║   ██║
  ╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝  ██║      ███╔╝  ██╔══╝  ██╔══██╗██║   ██║
  ███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗███████╗███████╗███████╗██║  ██║╚██████╔╝
  ╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ 
```

**When systems fail, command continues.**

*An independent, real-time, AI-assisted cyber incident coordination and operational continuity command center.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)
[![TypeScript 5.6](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![SpacetimeDB](https://img.shields.io/badge/SpacetimeDB-2.14.1-FF4081)](https://spacetimedb.com/)
[![NVIDIA Nemotron](https://img.shields.io/badge/NVIDIA-Nemotron-76B900?logo=nvidia)](https://developer.nvidia.com/topics/ai/Nemotron)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?logo=tailwindcss)](https://tailwindcss.com/)

</div>

---

## Executive Summary

When advanced ransomware or state-sponsored intrusions strike an enterprise, attackers routinely compromise internal communication channels first: Active Directory domain controllers, Microsoft Exchange / Google Workspace mailboxes, internal DNS, and administrative endpoint management tools. Responders attempting to coordinate over compromised internal networks inadvertently leak mitigation plans to the adversary or find themselves locked out entirely.

**SentinelZero** is an independently hosted, out-of-band cyber incident command and operational continuity platform. It bridges technical compromise evidence with mission-critical continuity operations—ensuring leadership, IT responders, clinicians, and coordinators maintain real-time situational awareness and command authority.

It is **not** an EDR, forensic acquisition suite, or autonomous destructive remediation engine. Instead, it provides:
1. **The Cyber-to-Human Impact Graph:** Links compromised technical assets to disrupted services and potentially affected operational units while strictly preserving forensic uncertainty.
2. **Real-time Reactive Coordination:** Powered by private tables, authorized subscriptions, and transactional reducers in **SpacetimeDB**.
3. **AI Copilot with Human Commander Sign-off:** Uses **NVIDIA Nemotron** to analyze evidence and propose containment workflows without allowing the model to approve its own consequential actions.
4. **Resilient Out-of-Band Comms & Hash-Chained Audit Ledger:** Verifiable cryptographic integrity that operates completely outside the victim organization's infrastructure.

---

## Key Pillars & Architectural Invariants

### 1. Cyber-to-Human Impact Graph
Traditional dashboards display isolated asset lists or generic alerts. SentinelZero introduces a multi-tier topological graph:
- **Layer 0 (Cyber Assets):** Servers, databases, workstations, identity providers, and network boundaries tracked with forensic compromise and availability states (`UNKNOWN`, `SUSPECTED`, `CONFIRMED`, `RULED_OUT`).
- **Layer 1 (Operational Services):** Core business and clinical applications (e.g., EHR Charting, Diagnostic Imaging PACS, Automated Pharmacy Dispensing).
- **Layer 2 (Affected Human Units):** Hospital and operational departments (Emergency Dept, ICU, Surgical Teams, Pharmacy) that must activate physical downtime procedures.
- **Uncertainty Preservation:** Data exfiltration and ransomware encryption are tracked independently. Suspected impacts remain unverified until confirmed by forensic artifacts, and personal harm is never inferred from service dependency alone.
- **Dual 2D/3D Rendering:** An accessible, keyboard-navigable React Flow 2D graph is the canonical baseline; an optional React Three Fiber / Drei 3D interactive scene consumes the exact same normalized state with WebGL and reduced-motion guardrails.

### 2. Transactional & Real-Time Operational State (SpacetimeDB)
- **Zero Polling:** Subscriptions push real-time updates to all connected responders within sub-second latencies.
- **Reducer Authorization:** Every mutation (`create_incident`, `transition_incident_status`, `create_task`, `approve_task`, `reject_task`, `send_message`) is validated server-side against caller identity, organization tenancy, and explicit role permissions.
- **Private Tables by Default:** Incident data is strictly partitioned; unauthorized cross-tenant queries fail by construction.

### 3. NVIDIA Nemotron AI Copilot (Human-in-the-Loop)
- Grounded in **NIST SP 800-61 Rev.3** Computer Security Incident Handling Guide.
- **Four specialist sub-agents, one shared budget.** The default mode (`AI_AGENT_MODE=orchestrated`) runs Nemotron as a sequence of specialists. Each one may call only its own tools. Step, tool-call, context, and deadline limits apply to the whole run, not to each specialist separately.

| Sub-agent | Job | Tools |
|:---|:---|:---|
| **triage** | Verified facts and open questions | `get_incident`, `get_evidence_summaries` |
| **impact** | Asset → service → human-unit map. Does not upgrade `UNKNOWN` or `SUSPECTED` | `get_assets`, `get_dependencies` |
| **containment** | Pending containment and recovery proposals | `get_open_tasks`, `propose_task` |
| **communications** | Out-of-band sitrep draft. It is not sent. | none |
- A call outside that subset is denied and the run fails without submitting a recommendation. `AI_AGENT_MODE=single` keeps the earlier one-loop agent.
- **No Self-Approval or Direct Execution:** Only containment may propose work, and only as `PENDING`. An Incident Commander approves or rejects in the operational backend. The model has no approve, isolate, delete, or execute tool.
- **Truthful Telemetry:** Scripted and exercise runs are labeled `SIMULATED` / `EXERCISE SCENARIO`. `LIVE` is used only when the service actually calls NVIDIA. The configured model defaults to `nvidia/nemotron-3-super-120b-a12b` and is set with `AI_NVIDIA_MODEL`.

### 4. Cryptographic Hash Chain Audit Ledger
- Every state mutation appends an entry to a deterministic hash chain (`previous_hash` &rarr; `event_hash`).
- Provides tamper-evident logging of status transitions, commander approvals, and forensic evidence uploads (SHA256 checksums and TLP tagging).

---

## System Topology

```
                  Authorized Responders (HTTPS / Secure WSS)
                                     │
           ┌─────────────────────────┴────────────────────────┐
           ▼                                                  ▼
┌─────────────────────────────┐                    ┌─────────────────────┐
│      Web Command Center     │                    │  Out-of-Band Auth   │
│   (React 18 + Vite + TS)    │                    │ (OIDC / Pre-Enrolled│
│                             │                    │    Identities)      │
│ ├─ KPI Overview & Lifecycle │                    └──────────┬──────────┘
│ ├─ Tasks & Human Approvals  │                               │
│ ├─ Cyber-to-Human Graph     │                               │
│ │   (2D Flow / 3D R3F)      │                               │
│ └─ Out-of-Band Comms Channel│                               │
└──────────────┬──────────────┘                               │
               │                                              │
               │ WSS (Authorized Views & Subscriptions)       │ Verified Token
               ▼                                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      SpacetimeDB Module (Backend)                      │
│                                                                        │
│ ├─ Private Tables: Incidents, Assets, Tasks, Messages, Audit Events    │
│ ├─ Reducers: create_incident, transition_status, approve_task, etc.    │
│ └─ Role-Based Security: OWNER, COMMANDER, ANALYST, RESPONDER, OBSERVER │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▲
               Authorized Queries  │ (Service Principal)
                                   │
┌──────────────────────────────────┴─────────────────────────────────────┐
│                      FastAPI AI Copilot Service                        │
│                                                                        │
│ ├─ Orchestrator: triage → impact → containment → communications        │
│ ├─ Per-sub-agent allowlists, one shared step / tool / time budget       │
│ └─ NVIDIA Nemotron (default nemotron-3-super-120b-a12b) or scripted mode│
└────────────────────────────────────────────────────────────────────────┘
```

---

## Role-Based Access Control (RBAC) Matrix

SentinelZero enforces a strict five-role security matrix on all operations:

| Capability | OWNER | COMMANDER | ANALYST | RESPONDER | OBSERVER |
|:---|:---:|:---:|:---:|:---:|:---:|
| **Manage Organization & Memberships** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Declare New Incident** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Approve Consequential Tasks** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Transition Incident Status (Lifecycle)** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Reopen Closed Incident (with Justification)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Update Asset Forensic Status** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Execute & Advance Assigned Tasks** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Broadcast Out-of-Band Messages** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Request an AI Analysis** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Read Authorized Incident Summaries** | ✅ | ✅ | ✅ | ✅ | ✅ |

*Note: `OBSERVER` accounts are cryptographically restricted to read-only views.*

---

## Incident Lifecycle State Machine

SentinelZero enforces explicit allowed transitions in compliance with standard incident response guidelines:

```
  [REPORTED] ───────────────► [TRIAGING] ───────────────► [INVESTIGATING]
       │                           │                              │
       │ (False alarm)             │ (Ruled out)                  │
       ▼                           ▼                              ▼
    [CLOSED] ◄───────────────── [CLOSED] ◄──────────────────── [CLOSED]
       │
       │ (Commander-only Reopen + Justification)
       └───────────────────────────► [TRIAGING]
                                        ▲
  [INVESTIGATING] ──────────► [CONTAINING] ─────────────► [CONTAINED]
                                    ▲                          │
                                    │ (Lateral spread)         ▼
                                    └──────────────────── [RECOVERING]
                                                               │
                                                               ▼
                                                          [RESOLVED]
                                                               │
                                                               ▼
                                                           [CLOSED]
```

---

## Repository Structure

```text
sentinelzero/
├── README.md                       # This overview
├── package.json                    # Root scripts for the SpacetimeDB packages (v1.1.0)
├── docs/                           # Integration contract, security model, data model, testing
│
├── apps/
│   └── web/                        # React 18 / Vite / TypeScript Command Center (pnpm)
│       ├── index.html              # HTML shell with accessibility metadata
│       ├── package.json            # Web application dependencies & scripts
│       ├── vite.config.ts          # Vite build config with manual chunking
│       ├── vitest.config.ts        # Vitest configuration for unit & component tests
│       ├── tailwind.config.js      # Dark command center design tokens
│       └── src/
│           ├── app/                # Application shell, router, providers & error boundary
│           ├── components/
│           │   ├── ai/             # Copilot panel and the four-sub-agent pipeline
│           │   ├── communications/ # Out-of-band real-time incident chat
│           │   ├── dashboard/      # KPI overview metrics & sitrep cards
│           │   ├── graph/          # 2D React Flow graph, custom nodes, inspector drawer
│           │   ├── incidents/      # Incident declaration modal & lifecycle progress bar
│           │   ├── layout/         # TopBar, Sidebar, and Disconnected status banner
│           │   ├── tasks/          # Kanban task board, human approvals & creation modal
│           │   ├── three/          # Optional 3D scene (React Three Fiber + Drei)
│           │   └── ui/             # Reusable UI primitives (Badges, Buttons, Modals)
│           ├── fixtures/           # Typed synthetic exercise fixtures (Hope Valley Hospital)
│           ├── hooks/              # Custom hooks (useAuth, useIncidents, useTasks, useConnection)
│           ├── pages/              # Routed pages (CommandCenter, Graph, Tasks, Comms, Admin)
│           ├── services/           # SpacetimeDB client, AI client, and graph transforms
│           ├── stores/             # Zustand state stores (uiStore, graphStore)
│           └── tests/              # Vitest suites (56 tests: UI, lifecycle, auth, graph, AI panel)
│
├── packages/
│   ├── shared/                     # Shared TypeScript schemas, enums, limits & graph contracts
│   └── spacetime/                  # SpacetimeDB backend module (reducers, private views, bindings)
│
├── services/
│   └── ai/                         # FastAPI service: Nemotron orchestrator, tools, guardrails
│       └── app/agents/             # orchestrator, four sub-agents, and the single-loop fallback
│
└── simulator/                      # Synthetic hospital ransomware seed & scenario replay
```

---

## Quickstart Guide

### Prerequisites
- **Node.js:** v20 or higher
- **Package Manager:** `pnpm` (v9+) for the web app, `npm` for the SpacetimeDB packages
- **Python:** 3.12+ (for the AI service)
- **SpacetimeDB CLI:** exactly 2.14.1 (matches the pinned `spacetimedb` npm package and the committed bindings)

---

### 1. Web Command Center (Frontend)

To run the accessible command center interface:

```powershell
# Navigate to web application
cd apps/web

# Install dependencies
pnpm install

# Run the test suite (56 tests)
pnpm test

# Run production build and verify bundle code splitting
pnpm run build

# Start local development server
pnpm run dev
```

Open **`http://localhost:5173`** in your browser.

#### Highlights in the Web UI:
- **Interactive Role Switcher:** Toggle between `COMMANDER`, `ANALYST`, `RESPONDER`, and `OBSERVER` in the top bar to verify real-time authorization checks.
- **Cyber-to-Human Impact Graph:** Switch between **2D FLOW** (React Flow) and **3D SCENE** (Three.js / React Three Fiber) seamlessly.
- **Human Commander Approvals:** Tasks requiring authorization appear with highlighted callouts; only Commander accounts can approve them.
- **NVIDIA Nemotron Copilot:** Click **"AI Incident Copilot"**. With no AI service configured, the panel runs a local exercise and labels it `EXERCISE SCENARIO` / `SIMULATED`. Point `VITE_AI_SERVICE_URL` at the FastAPI service (default `http://localhost:8000`) to use a real run. Observers and responders cannot start an analysis. The panel never approves a recommendation.
- **Connection Outage Simulation:** Click the green **"CONNECTED"** status pill in the top bar to simulate an operational network disconnect and test local UI resilience.

---

### 2. SpacetimeDB Backend Module

To compile and publish the SpacetimeDB transactional module:

Integration contract (connection, auth, views, reducers, AI flow): [`docs/INTEGRATION_CONTRACT.md`](docs/INTEGRATION_CONTRACT.md). Security guarantees and limits: [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md).

```powershell
# From the repo root. Requires the SpacetimeDB 2.14.1 CLI.
$env:SPACETIME_CLI = "<path to spacetimedb-cli 2.14.1>"   # or have `spacetime` on PATH
npm run setup                 # npm ci for packages/shared and packages/spacetime
npm run typecheck
npm run test:unit             # no server needed

# Integration tests and the demo need a local server (ES256 dev keys, never committed):
& $env:SPACETIME_CLI start --listen-addr 127.0.0.1:3000 --in-memory --jwt-pub-key-path <dir>\id_ecdsa.pub --jwt-priv-key-path <dir>\id_ecdsa
npm run test:integration      # publishes a throwaway database per run
npm run build; npm run seed:demo   # EXERCISE org + one account per role; tokens go to packages/spacetime/.demo/ (git-ignored)
```

---

### 3. FastAPI AI Service (NVIDIA Nemotron)

To launch the AI orchestration service:

Copy `services/ai/.env.example` to `services/ai/.env`. Do not commit the copy. `AI_PROVIDER_MODE=scripted` labels every run `SIMULATED` and does not call NVIDIA. `AI_PROVIDER_MODE=live` needs `NVIDIA_API_KEY` and is the only mode that may report `LIVE`. `AI_AGENT_MODE=orchestrated` is the default. Scripted mode is refused when `AI_ENVIRONMENT=production`.

```powershell
cd services/ai
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"

# Default suite. The live NVIDIA test stays skipped unless NVIDIA_API_KEY and AI_LIVE_TESTS=1 are set.
.\.venv\Scripts\python.exe -m pytest -q

# Scripted orchestrator against a local SpacetimeDB (see section 2). Token stays server-side.
$env:AI_ENVIRONMENT = "development"
$env:AI_PROVIDER_MODE = "scripted"
$env:AI_AGENT_MODE = "orchestrated"
$env:AI_BACKEND_MODE = "spacetimedb"
$env:AI_BACKEND_BASE_URL = "http://127.0.0.1:3000"
$env:AI_STDB_DB_NAME = "sentinelzero"
$env:AI_BACKEND_SERVICE_TOKEN = "<service-principal token from seed-demo>"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The browser calls `POST /v1/incidents/{id}/analyze`, then polls `GET /v1/agent-runs/{run_id}`. That payload includes `subagents` (triage, impact, containment, communications) and `sitrep`. A finished run submits one `PENDING` recommendation. Limits, redaction, and what has not been verified against live NVIDIA are in [`docs/limitations.md`](docs/limitations.md) and [`docs/testing.md`](docs/testing.md).

---

## Verification & Testing Overview

Counts below are from this working tree on **2026-11-08**, not a standing badge.

| Layer | How to run | What it covers | Last result |
|:---|:---|:---|:---:|
| **Web command center** | `pnpm test` in `apps/web` | Components, lifecycle, roles, graph, AI client, sub-agent panel, XSS-sink scan | 56 passed |
| **SpacetimeDB unit** | `npm run test:unit` from the repo root | Contracts and security helpers. No server. | 27 passed |
| **SpacetimeDB integration** | `npm run test:integration` with `SZ_STDB_URI` | Tenancy, OIDC issuer policy, approvals, revocation, rate limits, closed-incident writes, AI service principal | 40 passed |
| **AI service** | `pytest` in `services/ai` | Auth, bounds, allowlists, orchestrated sub-agents, wire protocol. Live NVIDIA is `pytest -m live` and stays skipped without a key. | See [`docs/testing.md`](docs/testing.md) |

---

## Fictional Demonstration Scenario: Hope Valley Community Hospital

SentinelZero includes pre-configured synthetic exercise fixtures representing a ransomware crisis at **Hope Valley Community Hospital (HVCH)**:
- **12 Cyber Assets:** Primary EHR database, web portals, PACS radiology storage, Active Directory domain controllers, firewalls, and pharmacy dispensing hubs.
- **3 Disrupted Operational Services:** Emergency clinical charting (Outage), diagnostic radiology image retrieval (Outage), automated medication dispensing (Degraded).
- **4 Impacted Human Teams:** Emergency Dept, ICU Nursing, Trauma Surgery, and Floor Nurses operating under physical paper downtime procedures.
- **Forensic Evidence:** TLP-Amber LockBit 3.0 ransom note and TLP-Red egress PCAP capture.
- **Exfiltration Uncertainty:** Data scopes reflect 142,000 PHI records encrypted on the primary EHR database with exfiltration marked **`UNKNOWN`** (preserving truthfulness without premature breach declarations).

---

## Security & Responsible Disclosure

SentinelZero is engineered to maintain operational resilience under adverse cyber conditions. Key security commitments:
- **Zero Client-Side Secrets:** Private keys, service tokens, and provider credentials (`NVIDIA_API_KEY`) are strictly retained on the backend and never exposed in browser bundles.
- **Independent Identity:** SentinelZero uses pre-enrolled out-of-band identities rather than relying on the victim organization's compromised Active Directory or corporate single-sign-on.
- **No Autonomous Destructive Actions:** The AI copilot cannot disable accounts, isolate endpoints, delete evidence, or approve its own proposals.
- **Honest Telemetry:** Synthetic exercise runs are explicitly labeled (`EXERCISE SCENARIO`), and hash chaining is presented honestly as cryptographic chaining rather than an immutable public blockchain.

Authorization, tenant isolation, rate limits, and the AI boundary are in [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) and [`docs/threat-model.md`](docs/threat-model.md). Closed incidents reject child writes. The exceptions are a commander reopen, cancelling an in-flight AI run, and completing that run.

---

<div align="center">

**SentinelZero** — *When systems fail, command continues.*

Designed for emergency cyber response, operational continuity, and evidence-grounded incident command.

</div>
