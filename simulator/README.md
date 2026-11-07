# SentinelZero Simulator (EXERCISE ONLY)

Deterministic synthetic community-hospital ransomware exercise for the AI service
and demo. No command here touches a real host, database, patient, or network.

## Commands (from the repository root)

```powershell
python -m simulator reset            # clean baseline (2 tasks, 6 evidence items)
python -m simulator inject           # add ransomware effects, 3 impacts, 4 tasks
python -m simulator run              # reset-equivalent + inject in one deterministic file
python -m simulator status           # phase, counts, EXERCISE label, state hash
python -m simulator verify           # exit 1 on any invariant failure
```

Add `--state <path>` to isolate runs (tests use temp files). `inject` is idempotent.

The default file is `simulator/.state/state.json` and is gitignored. The AI service
reads it when `AI_BACKEND_MODE=memory` (MOCK backend).

## Guaranteed invariants

- 1 organization, 1 incident, 12 assets, 8 dependencies, 3 services, 4 members, 3 data scopes.
- Injected state: 3 operational impacts, 6 tasks, 12 evidence summaries, 16 audit events.
- Every data scope keeps `exfiltration_status: UNKNOWN` (including suspected ransomware).
- Scheduling is `CONFIRMED` unavailable; EHR database compromise is `SUSPECTED`.
- Every user identity uses the reserved `.invalid` domain; every record is labeled EXERCISE.
- Audit events are deterministically hash-chained; the state has a canonical SHA-256.
- Rebuilding the same phase produces byte-identical JSON.

## Agent 1 integration (MOCK)

`simulator/contract.py` and `simulator/http_adapter.py` declare the exact endpoints
and reducers needed from Agent 1. They intentionally raise until the contract is
frozen. Do not point this simulator at production infrastructure.
