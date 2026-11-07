"""Measure in-process service latency with the deterministic scripted provider.

This measures SentinelZero service overhead (auth, tool dispatch, validation,
store) plus a zero-latency model double. It is NOT a measurement of NVIDIA
Nemotron latency. Live latency requires NVIDIA_API_KEY and an external run.

Usage (from services/ai):
    python tests/performance/measure_latency.py --runs 10
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import secrets
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

AI_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(AI_DIR))

import httpx  # noqa: E402

from app.auth import mint_test_token  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from simulator.seed import build_state, load_scenario  # noqa: E402

INCIDENT = "inc_riverbend_ransomware_001"
ORG = "org_riverbend_001"
ANALYST = "analyst@riverbend.exercise.invalid"
OUTPUT = AI_DIR / "evidence" / "performance-simulated.json"


async def _one(client: httpx.AsyncClient, headers: dict[str, str]) -> dict:
    started = time.perf_counter()
    response = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze", json={}, headers=headers
    )
    response.raise_for_status()
    run_id = response.json()["run_id"]
    for _ in range(1_000):
        poll = await client.get(f"/v1/agent-runs/{run_id}", headers=headers)
        record = poll.json()
        if record.get("status") in {"COMPLETED", "FAILED", "CANCELLED"}:
            elapsed_ms = (time.perf_counter() - started) * 1000
            return {
                "run_id": run_id,
                "status": record["status"],
                "elapsed_ms": round(elapsed_ms, 2),
                "tool_calls": len(record.get("tool_calls", [])),
                "provider_calls": len(record.get("provider_calls", [])),
            }
        await asyncio.sleep(0.005)
    raise RuntimeError("run did not finish")


def _summary(samples: list[float]) -> dict:
    ordered = sorted(samples)

    def pct(p: float) -> float:
        pos = max(0, min(len(ordered) - 1, int(round(p * (len(ordered) - 1)))))
        return ordered[pos]

    return {
        "count": len(ordered),
        "min_ms": round(ordered[0], 2),
        "mean_ms": round(statistics.mean(ordered), 2),
        "p50_ms": round(pct(0.50), 2),
        "p95_ms": round(pct(0.95), 2),
        "max_ms": round(ordered[-1], 2),
        "samples_ms": [round(value, 2) for value in samples],
    }


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--output", default=str(OUTPUT))
    args = parser.parse_args()

    scenario = load_scenario()
    state = build_state(scenario, phase="injected")
    secret = secrets.token_urlsafe(48)
    settings = Settings(
        environment="test",
        jwt_secret=secret,
        provider_mode="scripted",
        backend_mode="memory",
        rate_limit_per_minute=120,
        rate_limit_burst=20,
        max_concurrent_runs_per_user=10,
        run_deadline_seconds=30.0,
        max_stored_runs=1_000,
    )
    app = create_app(settings=settings, backend_state=state)
    token = mint_test_token(
        secret=secret, subject=ANALYST, organization_id=ORG, roles=["ANALYST"]
    )
    headers = {"Authorization": f"Bearer {token}"}

    warmup: list[dict] = []
    samples: list[dict] = []
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://perf.local"
        ) as client:
            for _ in range(max(0, args.warmup)):
                warmup.append(await _one(client, headers))
            for _ in range(max(1, args.runs)):
                samples.append(await _one(client, headers))
    finally:
        await app.state.runtime.aclose()

    durations = [item["elapsed_ms"] for item in samples]
    report = {
        "artifact": "agent3-performance",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "label": "SIMULATED_MODEL_OUTPUT",
        "measurement": "in-process ASGI service overhead with scripted zero-latency provider",
        "not_measured": (
            "Real NVIDIA Nemotron network/model latency. Set NVIDIA_API_KEY and run the "
            "live pytest to measure real inference latency."
        ),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cpu_count": os.cpu_count(),
        },
        "configuration": {
            "runs": len(samples),
            "warmup": len(warmup),
            "provider_mode": "scripted",
            "backend_mode": "memory",
        },
        "latency": _summary(durations),
        "runs": samples,
        "all_completed": all(item["status"] == "COMPLETED" for item in samples),
        "tool_calls_per_run": sorted({item["tool_calls"] for item in samples}),
        "provider_calls_per_run": sorted({item["provider_calls"] for item in samples}),
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["all_completed"], "path": str(output), "latency": report["latency"]}))
    return 0 if report["all_completed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
