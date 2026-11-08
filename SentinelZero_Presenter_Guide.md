# SentinelZero — Judge Presentation & Live Demo Guide
**Prepared for HackUTD 2026 NVIDIA Nemotron and Winstead PC tracks**  
**Source snapshot:** `main` commit `d345fc7c352a3f2163b656c0830fb7c3911e5460`, November 8, 2026.  
**Slide deck:** `SentinelZero_NVIDIA_Winstead_Judges_Demo.pptx` (18 slides, editable, with speaker notes).

## How to present this deck
The **core pitch** is slides **1–16**; slides **17–18** are backup evidence and citations. If judges give you only **3 minutes total**, use slides **1 → 2 → 4 → 6 → 7 → 12 → 14 → 16**, and prioritize the actual application over reading slides. If you have **5–7 minutes plus a live demo**, cover slides 1–11 rapidly, show the live application at slide 12, then finish at slides 13–16.

The image on the first slide is **concept artwork**, not a screenshot of a deployed app. Visuals, cards and workflow diagrams are presentation illustrations. The application itself should be opened live to establish what actually works.

## 3-minute demo walkthrough (click path)
| Time | Screen | Action | Exact message to judges |
|---|---|---|---|
| 0:00–0:25 | **Command Center** | Open a synthetic ransomware incident. Point out severity and lifecycle. | “When internal systems are compromised, the response needs one reliable operational picture.” |
| 0:25–0:55 | **Impact Graph** | Switch 2D → 3D, click a technical asset, follow a dependency to a service and operational unit. | “This turns a server incident into a business-continuity question. Potential impact is not proof of harm.” |
| 0:55–1:45 | **Nemotron console** | Open the agent panel, show Triage → Impact → Containment → Communications. If possible, show sanitized tool trace. | “Our AI is designed to execute a bounded tool workflow, not just answer a prompt. It cannot approve its own recommendations.” |
| 1:45–2:15 | **Tasks & Approvals** | Review a pending recommendation; approve using the **real authorized backend** only if tested. Show resulting task. | “AI proposes. An accountable commander decides.” |
| 2:15–2:45 | **Data Scope + Comms** | Show encrypted records vs exfiltration `UNKNOWN`, then communication feed. | “We separate what is known from what is still being investigated—and preserve the discussion in one incident record.” |
| 2:45–3:00 | **Audit / closing** | Show audit chain and finish with one-line value proposition. | “SentinelZero gives responders a command layer when the environment they normally trust is no longer trustworthy.” |

**Important safety check:** The current frontend `spacetimeClient.ts` still initializes from local mock fixtures. Do not describe a browser-local task or a visually changed role as a proven live multi-user backend transaction unless you test the exact behavior against SpacetimeDB first. The AI client also supports labeled `EXERCISE SCENARIO` fallback; do not call a scripted run live NVIDIA inference.

## Suggested 75-second opening (slides 1–4)
“Imagine a hospital under ransomware attack. The database is encrypted, staff cannot reach normal systems, and the team is trying to coordinate through the same email and identity infrastructure the attacker may already control. We don't need another alert on a screen. We need a trusted incident command picture. That's SentinelZero. We bring structured incident records, real-time coordination, a Cyber-to-Human Impact Graph, and an NVIDIA Nemotron agent workflow into one response interface. The differentiator is what happens after detection: we show which services depend on affected assets, keep uncertainty visible, and turn AI recommendations into tasks only after human approval.”

## How to explain the tech stack without confusing judges
| Component / API | Location in code | Reason for using it | Status |
|---|---|---|---|
| **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b`) | `services/ai/app/config.py`, `services/ai/app/llm/nemotron_client.py` | LLM designed for reasoning and tool calls; serves the four-stage agent pipeline | Model configured; **live inference not verified** in repo testing |
| **NVIDIA/OpenAI-compatible Chat Completions** | `services/ai/app/llm/nemotron_client.py` | LLM API calls carrying tool schemas, tool results and structured output | Wire mocked and tested; external call unverified |
| **FastAPI REST API** | `services/ai/app/routes/analyze.py` | Start asynchronous analysis; retrieve run status; allow cancellation | Implemented with scripted tests |
| **SpacetimeDB 2.14.1 HTTP API** | `services/ai/app/backend.py`, `docs/INTEGRATION_CONTRACT.md` | AI service calls authorized backend procedures and reducers | Adapter implemented; live multi-service test not documented |
| **SpacetimeDB SDK/WebSockets** | `packages/spacetime/bindings`, `apps/web/src/services/spacetimeClient.ts` | Reactive state and server-side authorization for incident teams | Backend tests documented; browser frontend still uses exercise-local client by default |
| **OIDC/JWT / RBAC** | `packages/spacetime/src/security`, `docs/SECURITY_MODEL.md` | Independent identities, least privilege, revocation | Tests documented; no production identity deployment/pentest |
| **React / TypeScript / Vite** | `apps/web` | Fast web command console with typed components | Source present, tests documented |
| **Tailwind + Framer Motion + Lucide** | `apps/web` | Consistent visual hierarchy, purposeful motion and iconography | Source present (`AnimatedStatCard.tsx`) |
| **React Flow + React Three Fiber / Three.js** | `apps/web/src/components/graph`, `/three` | 2D accessibility and 3D situational exploration | Source present; not a substitute for operational validation |
| **Pydantic / httpx / PyJWT** | `services/ai` | Request validation, outbound API calls, identity checks | Used in AI service |

**Do not claim integrations with Splunk, CrowdStrike, Sentinel, Palo Alto, or other external SOC APIs unless you actually add them.** These are market comparisons, not current SentinelZero connected services.

## What the current metrics mean
- **$4.99 million** is **IBM's 2026 global average data-breach cost**, not savings delivered by SentinelZero.
- **56%** is IBM's reported increase in AI-enabled attacks, not SentinelZero detection accuracy.
- **202 passing tests** is the sum of recorded project results: 56 web + 27 backend unit + 40 backend integration + 79 AI Python. These were not independently executed for the presentation. The AI default suite has **1 skipped live NVIDIA test**.
- **12 assets, 3 disrupted services, 4 human groups, 142k encrypted PHI records** are **synthetic Hope Valley UI scenario values**, not actual hospital statistics. The standalone simulator uses a separate Riverbend fictional scenario.
- The project does **not** report validated production uptime, breach-cost reduction, mean time to resolve, live inference latency, or number of actual customers.
- **The most recent GitHub Actions CI run failed** at the source snapshot. Treat it as a fix-before-submission issue, not a successful validation.

## Market positioning: speak accurately
- **Palo Alto Cortex XSOAR** already provides a mature automation ecosystem, incident war room, and hundreds of integrations. Don't say it lacks AI or collaboration.
- **ServiceNow Security Incident Response** already provides automated case management, contextual asset information, and enterprise workflows.
- **TheHive** is an established collaborative case-management offering.

**Differentiating thesis:** SentinelZero is a *focused*, out-of-band incident **command/continuity** layer, with a visible cyber-to-human dependency model, evidence uncertainty, and a proposal-only Nemotron orchestrator. It is not a proven replacement for those mature products; it is a differentiated prototype, potentially complementary to their detection/automation systems.

## 6 likely judge questions and answers
**Q: Why would an enterprise buy this instead of XSOAR or ServiceNow?**  
A: “Those platforms are mature and broad. SentinelZero targets the command and continuity gap when internal dependencies may be compromised. Our focus is immediate shared operational context, uncertainty tracking, and controlled AI proposals. Our current prototype would need production integrations, hosting and security validation before an enterprise rollout.”

**Q: Is Nemotron genuinely running or a mock?**  
A: “The repository contains an NVIDIA Nemotron API client and four-stage orchestrator, with local scripted tests and simulated labels. As of the reviewed test report, live inference had not been run because an NVIDIA key was not configured. We will say ‘live’ only when a real NVIDIA request succeeds and the run proves it.”

**Q: Can an attacker use your dashboard?**  
A: “The backend enforces authorization at reducers and views and has cross-tenant/revocation test coverage. For the Winstead threat model, deployment must also isolate infrastructure, credentials, and identity from the compromised organization. That deployment boundary has not yet been independently pen-tested.”

**Q: Can AI shut down a server or accidentally approve its own action?**  
A: “No. The current design restricts AI to data retrieval and pending task proposals. Approval is a separate authorized operation on the server. There are no destructive isolation/execute tools available to the model.”

**Q: Why use 3D?**  
A: “It is an optional exploratory view for understanding multi-layer dependencies. The 2D graph uses the same underlying model and remains the accessible default and fallback. The goal is not visual spectacle; it is faster recognition of operational dependencies.”

**Q: What did your tests prove?**  
A: “Recorded tests cover authorization, data contracts, graph transformations, scripted agent orchestration, schema and evidence controls. They do not prove production resilience or live NVIDIA model behavior. Our backlog includes live-model tests, browser end-to-end validation, and CI repair.”

## Pre-demo sanity checklist
1. Confirm the GitHub `main` SHA and that the app opens from a clean local checkout.
2. Confirm whether your current app is in **live SpacetimeDB mode** or **exercise mode**; use accurate labels on screen.
3. Check the actual NVIDIA API endpoint and `NVIDIA_API_KEY` in the server environment (never show or paste the key).
4. Verify the AI `/health` provider status and distinguish `LIVE` from `SIMULATED`.
5. Test the complete approval flow against the backend, not just the frontend local `createTask()` path.
6. If demonstrating multi-user synchronization, use two separate authenticated sessions and verify the second session receives the database update.
7. Fix or explicitly explain the failed CI; do not flash a false passing badge.
8. Keep a pre-recorded screen capture in case network/model inference fails; label it as a recording.
9. Practice the closing line: **“When systems fail, command continues.”**

## References
- SentinelZero repository: https://github.com/Saumya-Patel-10/SentinelZero
- Project integration contract: https://github.com/Saumya-Patel-10/SentinelZero/blob/main/docs/INTEGRATION_CONTRACT.md
- Security model: https://github.com/Saumya-Patel-10/SentinelZero/blob/main/docs/SECURITY_MODEL.md
- Latest AI testing notes: https://github.com/Saumya-Patel-10/SentinelZero/blob/main/docs/testing.md
- Latest action observed: https://github.com/Saumya-Patel-10/SentinelZero/actions/runs/42502824254
- IBM 2026 research: https://newsroom.ibm.com/2026-07-29-ibm-study-one-in-four-malicious-breaches-are-ai-enabled%2C-costing-companies-6-million-on-average
- NVIDIA Nemotron model: https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b
- Cortex XSOAR: https://www.paloaltonetworks.com/cortex/cortex-xsoar
- ServiceNow SIR: https://www.servicenow.com/products/security-incident-response.html
- TheHive: https://github.com/TheHive-Project/TheHive
