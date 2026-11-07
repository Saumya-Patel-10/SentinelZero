"""Generate a truthfulness-first evidence artifact for the tool round trip.

This script exercises the real Nemotron client against a local httpx MockTransport
that speaks the NVIDIA OpenAI-compatible wire protocol. It is deliberately labeled
SIMULATED_MODEL_OUTPUT: no live NVIDIA inference is performed here.

Usage (from services/ai):
    python scripts/generate_evidence.py
"""

from __future__ import annotations

import asyncio
import json
import platform
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AI_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(AI_DIR))

import httpx  # noqa: E402

from app.auth import mint_test_token  # noqa: E402
from app.config import Settings  # noqa: E402
from app.llm.nemotron_client import NemotronProvider  # noqa: E402
from app.llm.types import ProviderDescriptor  # noqa: E402
from app.main import create_app  # noqa: E402
from simulator.seed import build_state, load_scenario, verify_state  # noqa: E402

INCIDENT = "inc_riverbend_ransomware_001"
ORG = "org_riverbend_001"
ANALYST = "analyst@riverbend.exercise.invalid"
BASE_URL = "https://integrate.api.nvidia.com/v1"
MODEL = "nvidia/nemotron-3-super-120b-a12b"
OUTPUT = AI_DIR / "evidence" / "tool-roundtrip-simulated.json"


class FakeNemotronTransport:
    """Sequenced wire-level double; never used as a production fallback."""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.requests: list[dict[str, Any]] = []
        self.index = 0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        self.requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": body,
            }
        )
        response = self.responses[self.index]
        self.index += 1
        return response

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def _tool_turn(calls: list[tuple[str, str]]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-evidence-tools",
            "model": MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {"name": name, "arguments": "{}"},
                            }
                            for call_id, name in calls
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 512, "completion_tokens": 32},
        },
        headers={"x-request-id": "req-evidence-tools"},
    )


def _final_turn(payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-evidence-final",
            "model": MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": json.dumps(payload)},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 2048, "completion_tokens": 420},
        },
        headers={"x-request-id": "req-evidence-final"},
    )


def _recommendation_payload(state: dict[str, Any]) -> dict[str, Any]:
    evidence = sorted(item["id"] for item in state["evidence_references"])
    first = evidence[0]
    return {
        "summary": (
            "SIMULATED WIRE-TEST OUTPUT. Evidence preservation and continuity review are "
            "proposed for human approval. Exfiltration remains UNKNOWN."
        ),
        "facts": [
            {
                "statement": "Evidence metadata was returned by the read-only evidence tool.",
                "evidence_ids": [first],
                "confidence": 0.8,
                "verification_status": "SUSPECTED",
            }
        ],
        "uncertainties": [
            {
                "question": "Was data exfiltrated?",
                "why_unknown": "No confirmed exfiltration evidence was returned.",
                "impact_if_true": "Notification obligations could expand.",
                "resolution_step": "Validate egress and database audit evidence.",
                "related_evidence_ids": [first],
            }
        ],
        "proposed_tasks": [
            {
                "title": "Preserve and hash evidence for the incident",
                "description": "Preserve and hash authorized evidence; do not delete sources.",
                "priority": "CRITICAL",
                "rationale": "Evidence must be preserved before recovery.",
                "evidence_ids": [first],
                "evidence_basis": "EVIDENCE_BACKED",
                "risk_level": "LOW",
                "assigned_role": "ANALYST",
            }
        ],
        "limitations": ["Wire-level test double output; not live NVIDIA inference."],
    }


async def _poll(client: httpx.AsyncClient, run_id: str, headers: dict[str, str]) -> dict:
    for _ in range(400):
        response = await client.get(f"/v1/agent-runs/{run_id}", headers=headers)
        payload = response.json()
        if payload.get("status") in {"COMPLETED", "FAILED", "CANCELLED"}:
            return payload
        await asyncio.sleep(0.02)
    raise RuntimeError("run did not finish")


async def main() -> int:
    scenario = load_scenario()
    state = build_state(scenario, phase="injected")
    verification = verify_state(state)
    if not verification["ok"]:
        raise RuntimeError(f"simulator verification failed: {verification['errors']}")

    secret = secrets.token_urlsafe(48)
    settings = Settings(
        environment="test",
        jwt_secret=secret,
        jwt_issuer="sentinelzero-auth",
        jwt_audience="sentinelzero-ai",
        provider_mode="live",
        backend_mode="memory",
        nvidia_api_key="nvapi-local-test-double-not-a-real-secret",
        nvidia_base_url=BASE_URL,
        nvidia_model=MODEL,
        nvidia_max_retries=0,
        max_steps=6,
        max_tool_calls=10,
        run_deadline_seconds=20.0,
        rate_limit_per_minute=100,
        rate_limit_burst=10,
        max_concurrent_runs_per_user=5,
        max_stored_runs=100,
    )

    calls = [
        ("call_incident", "get_incident"),
        ("call_assets", "get_assets"),
        ("call_dependencies", "get_dependencies"),
        ("call_tasks", "get_open_tasks"),
        ("call_evidence", "get_evidence_summaries"),
    ]
    fake = FakeNemotronTransport(
        [_tool_turn(calls), _final_turn(_recommendation_payload(state))]
    )
    provider = NemotronProvider(settings, transport=fake.transport)
    # The wire protocol is real; the transport is a local test double. Label the
    # resulting run as simulated so no consumer can mistake it for live inference.
    provider.descriptor = ProviderDescriptor(
        mode="scripted",
        endpoint_class="SIMULATED_WIRE_TEST_DOUBLE",
        model_identifier=MODEL,
        inference_label="SIMULATED_MODEL_OUTPUT",
        configured=True,
    )
    app = create_app(settings=settings, provider=provider, backend_state=state)

    token = mint_test_token(
        secret=secret,
        subject=ANALYST,
        organization_id=ORG,
        roles=["ANALYST"],
    )
    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://evidence.local"
        ) as client:
            accepted = await client.post(
                f"/v1/incidents/{INCIDENT}/analyze",
                json={"focus": "Preserve uncertainty about exfiltration."},
                headers=headers,
            )
            accepted.raise_for_status()
            accepted_body = accepted.json()
            run = await _poll(client, accepted_body["run_id"], headers)
    finally:
        await app.state.runtime.aclose()

    first_body = fake.requests[0]["body"]
    second_body = fake.requests[1]["body"]
    messages = second_body["messages"]
    tool_messages = [m for m in messages if m.get("role") == "tool"]
    assistant_messages = [m for m in messages if m.get("role") == "assistant"]

    checks = {
        "run_completed": run.get("status") == "COMPLETED",
        "provider_turns_2": len(run.get("provider_calls", [])) == 2,
        "tool_calls_5": len(run.get("tool_calls", [])) == 5,
        "only_allowlisted_tools": {c["tool_name"] for c in run.get("tool_calls", [])}
        == {name for _, name in calls},
        "approval_pending": run.get("recommendation", {}).get("approval_status")
        == "PENDING_HUMAN_APPROVAL",
        "all_tasks_need_human": all(
            task.get("requires_human_approval") is True
            for task in run.get("recommendation", {}).get("proposed_tasks", [])
        ),
        "exfiltration_uncertainty_recorded": any(
            item.get("question") == "Was data exfiltrated?"
            for item in run.get("recommendation", {}).get("uncertainties", [])
        ),
        "request_url_correct": fake.requests[0]["url"] == f"{BASE_URL}/chat/completions",
        "bearer_auth_present": fake.requests[0]["headers"]["authorization"].startswith(
            "Bearer nvapi-"
        ),
        "tools_declared": len(first_body.get("tools", [])) == 6,
        "tool_choice_auto": first_body.get("tool_choice") == "auto",
        "followup_has_assistant_tool_calls": bool(assistant_messages)
        and len(assistant_messages[0].get("tool_calls", [])) == 5,
        "followup_has_tool_messages": len(tool_messages) == 5,
        "followup_has_response_format": "response_format" in second_body,
        "no_secret_in_run": "nvapi-" not in json.dumps(run) and secret not in json.dumps(run),
        "run_labeled_simulated": run.get("inference_label") == "SIMULATED_MODEL_OUTPUT",
    }
    if not all(checks.values()):
        failed = [name for name, value in checks.items() if not value]
        raise RuntimeError(f"evidence checks failed: {failed}")

    artifact = {
        "artifact": "agent3-tool-roundtrip",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "label": "SIMULATED_MODEL_OUTPUT",
        "live_inference": False,
        "why_not_live": (
            "No NVIDIA_API_KEY was available. The NVIDIA OpenAI-compatible protocol was "
            "exercised against a local httpx MockTransport test double."
        ),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "protocol": {
            "style": "OpenAI-compatible chat completions",
            "transport": "local httpx.MockTransport test double",
            "base_url": BASE_URL,
            "path": "/chat/completions",
            "model": MODEL,
            "requests": len(fake.requests),
            "tools_declared": [
                tool["function"]["name"] for tool in first_body.get("tools", [])
            ],
            "tool_choice": first_body.get("tool_choice"),
            "parallel_tool_calls": first_body.get("parallel_tool_calls"),
            "followup_roles": [message.get("role") for message in messages],
            "response_format_second_turn": second_body.get("response_format", {}).get("type"),
        },
        "simulator": {
            "scenario_id": state["scenario_id"],
            "phase": state["phase"],
            "state_sha256": state["integrity"]["state_sha256"],
            "counts": verification["counts"],
            "verify_ok": verification["ok"],
        },
        "run": {
            "status": run.get("status"),
            "provider_mode": run.get("provider_mode"),
            "inference_label": run.get("inference_label"),
            "endpoint_class": run.get("endpoint_class"),
            "tool_calls": [
                {
                    "tool_name": call["tool_name"],
                    "status": call["status"],
                    "duration_ms": call["duration_ms"],
                    "output_summary": call["output_summary"],
                }
                for call in run.get("tool_calls", [])
            ],
            "provider_calls": run.get("provider_calls", []),
            "recommendation": {
                "approval_status": run.get("recommendation", {}).get("approval_status"),
                "fact_count": len(run.get("recommendation", {}).get("facts", [])),
                "uncertainty_count": len(
                    run.get("recommendation", {}).get("uncertainties", [])
                ),
                "proposed_task_count": len(
                    run.get("recommendation", {}).get("proposed_tasks", [])
                ),
                "evidence_ids_used": run.get("recommendation", {}).get(
                    "evidence_ids_used", []
                ),
            },
        },
        "assertions": checks,
        "limitations": [
            "This artifact does not prove live NVIDIA inference or model quality.",
            "The backend is the in-memory simulator (MOCK-1), not SpacetimeDB.",
            "Run `python -m pytest -m live` with NVIDIA_API_KEY and AI_LIVE_TESTS=1 for live evidence.",
        ],
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "path": str(OUTPUT), "checks": len(checks)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
