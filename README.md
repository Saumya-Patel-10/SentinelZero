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

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript 5.6](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![SpacetimeDB](https://img.shields.io/badge/SpacetimeDB-2.0-FF4081)](https://spacetimedb.com/)
[![NVIDIA Nemotron](https://img.shields.io/badge/NVIDIA-Nemotron--4-76B900?logo=nvidia)](https://developer.nvidia.com/topics/ai/Nemotron)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?logo=tailwindcss)](https://tailwindcss.com/)
[![Tests Passing](https://img.shields.io/badge/Tests-13%2F13%20Passing-emerald)](apps/web)

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
- **Allowlisted Read-Only Tools:** The agent may only query incident context, asset inventories, and open tasks (`get_incident`, `get_assets`, `get_dependencies`, `propose_task`).
- **No Self-Approval or Direct Execution:** AI recommendations are recorded strictly as `PENDING` proposals. An authenticated human Incident Commander must explicitly review and authorize proposals before tasks transition to active execution.
- **Truthful Telemetry:** Simulations and deterministic fallbacks are clearly labeled (`EXERCISE SCENARIO`) and never deceptively presented as live model inference.

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
│ ├─ NIST SP 800-61 Rev.3 Structured Reasoning & Tool Orchestration      │
│ ├─ Allowlisted Read Tools (get_incident, get_assets, propose_task)     │
│ └─ NVIDIA Nemotron-4-340B LLM Endpoint (Bounded Tokens & Latency)       │
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
├── ARCHITECTURE.md                 # Master system architecture specification
├── architecture.json               # Machine-readable architecture schema
├── README.md                       # Master project overview & documentation
├── package.json                    # Root workspace manifest
├── pnpm-workspace.yaml             # Workspace package orchestration
│
├── apps/
│   └── web/                        # React 18 / Vite / TypeScript Command Center
│       ├── index.html              # HTML shell with accessibility metadata
│       ├── package.json            # Web application dependencies & scripts
│       ├── vite.config.ts          # Vite build config with manual chunking
│       ├── vitest.config.ts        # Vitest configuration for unit & component tests
│       ├── tailwind.config.js      # Dark command center design tokens
│       └── src/
│           ├── app/                # Application shell, router, providers & error boundary
│           ├── components/
│           │   ├── ai/             # Nemotron AI copilot run modal & proposal cards
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
│           └── tests/              # Vitest test suites (13 unit/lifecycle/component tests)
│
├── packages/
│   ├── shared/                     # Shared TypeScript schemas, enums, limits & graph contracts
│   └── spacetime/                  # SpacetimeDB backend module (reducers, private views, bindings)
│
├── services/
│   └── ai/                         # Python FastAPI agent orchestration with NVIDIA Nemotron
│       ├── app/                    # Routes, tools, guardrails, and redaction logic
│       └── tests/                  # Pytest test suite for AI tools and validation
│
└── simulator/                      # Synthetic hospital ransomware seed & scenario replay
```

---

## Quickstart Guide

### Prerequisites
- **Node.js:** v18.0.0 or higher (v20+ recommended)
- **Package Manager:** `pnpm` (v9+) or `npm`
- **Python:** 3.11+ (for AI service)
- **SpacetimeDB CLI:** v2.0+ (for backend module deployment)

---

### 1. Web Command Center (Frontend)

To run the accessible command center interface:

```powershell
# Navigate to web application
cd apps/web

# Install dependencies
pnpm install

# Run the test suite (13 passing unit and component tests)
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
- **NVIDIA Nemotron Copilot:** Click **"AI Incident Copilot"** to simulate or execute structured Nemotron reasoning and allowlisted tool invocations.
- **Connection Outage Simulation:** Click the green **"CONNECTED"** status pill in the top bar to simulate an operational network disconnect and test local UI resilience.

---

### 2. SpacetimeDB Backend Module

To compile and publish the SpacetimeDB transactional module:

```powershell
cd packages/spacetime

# Install module dependencies
npm install

# Run backend unit and integration tests
npm test

# Publish module to local SpacetimeDB instance
spacetime publish --server local sentinelzero
```

---

### 3. FastAPI AI Service (NVIDIA Nemotron)

To launch the AI orchestration service:

```powershell
cd services/ai

# Create and activate virtual environment
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
# source .venv/bin/activate

# Install dependencies
pip install -e .

# Configure environment variables (create .env from example)
# NVIDIA_API_KEY=your_key_here

# Run pytest test suite
pytest

# Launch FastAPI server
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Verification & Testing Overview

The project maintains comprehensive test coverage across all layers:

| Layer | Test Runner | Scope | Status |
|:---|:---:|:---|:---:|
| **Frontend UI & Components** | Vitest (`apps/web`) | Component rendering, badge text labeling, connection banner | ✅ Passed (5/5) |
| **Frontend Lifecycle & State** | Vitest (`apps/web`) | Sequential transitions, disallowed transitions, commander reopen | ✅ Passed (3/3) |
| **Frontend Role Authorization** | Vitest (`apps/web`) | Commander approvals, observer mutation blocks | ✅ Passed (2/2) |
| **Graph Transformation** | Vitest (`apps/web`) | Uncertainty preservation, layer assignments, no invented edges | ✅ Passed (3/3) |
| **Shared Contracts** | Vitest (`packages/shared`) | Frozen schema validation, enum parsing, graph building | ✅ Passed |
| **SpacetimeDB Reducers** | Vitest (`packages/spacetime`)| Idempotency, tenancy isolation, permission checks | ✅ Passed |
| **AI Tool Guardrails** | Pytest (`services/ai`) | Allowlist enforcement, structured output schema, redaction | ✅ Passed |

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

For security reports or inquiries, please review our [SECURITY.md](SECURITY.md) guidelines.

---

<div align="center">

**SentinelZero** — *When systems fail, command continues.*

Designed for emergency cyber response, operational continuity, and evidence-grounded incident command.

</div>
