"""Shared pytest fixtures and fake provider helpers.

The fake provider is a wire-level HTTP test double, never a production fallback.
Every run created with the scripted provider is labeled SIMULATED_MODEL_OUTPUT.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

import httpx
import pytest

from app.auth import mint_test_token
from app.config import Settings
from app.main import create_app
from simulator.seed import build_state, load_scenario

TEST_SECRET = "test-only-secret-" + ("x" * 32)
ORG = "org_riverbend_001"
INCIDENT = "inc_riverbend_ransomware_001"
ANALYST = "analyst@riverbend.exercise.invalid"
COMMANDER = "commander@riverbend.exercise.invalid"
OWNER = "owner@riverbend.exercise.invalid"
RESPONDER = "responder@riverbend.exercise.invalid"


def test_settings(**overrides: Any) -> Settings:
    base = {
        "environment": "test",
        "jwt_secret": TEST_SECRET,
        "jwt_issuer": "sentinelzero-auth",
        "jwt_audience": "sentinelzero-ai",
        "provider_mode": "scripted",
        "backend_mode": "memory",
        "rate_limit_per_minute": 100,
        "rate_limit_burst": 10,
        "max_concurrent_runs_per_user": 5,
        "run_deadline_seconds": 20.0,
        "nvidia_max_retries": 0,
        "max_stored_runs": 100,
    }
    base.update(overrides)
    return Settings(**base)


# Imported into test modules as a helper; pytest must not collect it as a test.
test_settings.__test__ = False


def auth_headers(
    *,
    subject: str = ANALYST,
    roles: list[str] | None = None,
    organization_id: str = ORG,
    ttl_seconds: int = 900,
    audience: str = "sentinelzero-ai",
    issuer: str = "sentinelzero-auth",
    secret: str = TEST_SECRET,
) -> dict[str, str]:
    token = mint_test_token(
        secret=secret,
        subject=subject,
        organization_id=organization_id,
        roles=roles or ["ANALYST"],
        issuer=issuer,
        audience=audience,
        ttl_seconds=ttl_seconds,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def scenario() -> dict:
    return load_scenario()


@pytest.fixture()
def state(scenario: dict) -> dict:
    return build_state(scenario, phase="injected")


@pytest.fixture()
async def app_factory(state):
    apps = []

    def make(
        *,
        settings: Settings | None = None,
        provider: Any | None = None,
        backend_state: dict | None = None,
    ):
        application = create_app(
            settings=settings or test_settings(),
            backend_state=backend_state if backend_state is not None else state,
            provider=provider,
        )
        apps.append(application)
        return application

    yield make
    for application in apps:
        await application.state.runtime.aclose()


@pytest.fixture()
async def client_factory():
    clients: list[httpx.AsyncClient] = []

    async def make(application):
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://testserver"
        )
        clients.append(client)
        return client

    yield make
    for client in clients:
        await client.aclose()


async def wait_for_run(
    client: httpx.AsyncClient,
    run_id: str,
    headers: dict[str, str],
    *,
    timeout: float = 8.0,
) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    last: dict = {}
    while asyncio.get_running_loop().time() < deadline:
        response = await client.get(f"/v1/agent-runs/{run_id}", headers=headers)
        last = response.json()
        if last.get("status") in {"COMPLETED", "FAILED", "CANCELLED"}:
            return last
        await asyncio.sleep(0.02)
    raise AssertionError(f"Run did not finish in time: {last}")


def recommendation_payload(
    *,
    evidence_ids: list[str] | None = None,
    include_task: bool = True,
    summary: str | None = None,
) -> dict:
    evidence_ids = evidence_ids or ["ev_edr_alert"]
    facts = [
        {
            "statement": "An EDR alert is recorded for the affected EHR application.",
            "evidence_ids": [evidence_ids[0]],
            "confidence": 0.9,
            "verification_status": "SUSPECTED",
        }
    ]
    tasks = []
    if include_task:
        tasks.append(
            {
                "title": "Preserve evidence for the incident",
                "description": "Preserve and hash authorized evidence; do not delete sources.",
                "priority": "CRITICAL",
                "rationale": "Evidence must be preserved before recovery.",
                "evidence_ids": [evidence_ids[0]],
                "evidence_basis": "EVIDENCE_BACKED",
                "risk_level": "LOW",
                "assigned_role": "ANALYST",
            }
        )
    return {
        "summary": summary
        or "Suspected ransomware; exfiltration remains UNKNOWN. Proposals require human approval.",
        "facts": facts,
        "uncertainties": [
            {
                "question": "Was data exfiltrated?",
                "why_unknown": "No confirmed exfiltration evidence was returned.",
                "impact_if_true": "Legal and notification obligations could expand.",
                "resolution_step": "Validate network egress and database audit evidence.",
                "related_evidence_ids": evidence_ids[:1],
            }
        ],
        "proposed_tasks": tasks,
        "limitations": ["Test double response."],
    }


class FakeNemotron:
    """Sequenced OpenAI-compatible HTTP test double."""

    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.requests: list[dict[str, Any]] = []
        self._index = 0

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
        if self._index >= len(self.responses):
            raise AssertionError("Fake provider received more requests than expected")
        item = self.responses[self._index]
        self._index += 1
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return item(request)
        return item

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    @staticmethod
    def tool_turn(calls: list[tuple[str, str, str]]) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-fake",
                "model": "nvidia/nemotron-3-super-120b-a12b",
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
                                    "function": {"name": name, "arguments": args},
                                }
                                for call_id, name, args in calls
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20},
            },
            headers={"x-request-id": "req-fake"},
        )

    @staticmethod
    def final_turn(content: str | dict) -> httpx.Response:
        text = content if isinstance(content, str) else json.dumps(content)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-fake-final",
                "model": "nvidia/nemotron-3-super-120b-a12b",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 300, "completion_tokens": 80},
            },
            headers={"x-request-id": "req-fake-final"},
        )


def read_calls() -> list[tuple[str, str, str]]:
    return [
        ("call_inc", "get_incident", "{}"),
        ("call_assets", "get_assets", "{}"),
        ("call_evidence", "get_evidence_summaries", "{}"),
    ]


class RecordingBackend:
    """Wrap a backend and record the exact submission payload."""

    def __init__(self, inner):
        self.inner = inner
        self.mode = inner.mode
        self.contract_version = inner.contract_version
        self.submissions: list[dict[str, Any]] = []

    def __getattr__(self, name):
        return getattr(self.inner, name)

    async def authorize_incident(self, principal, incident_id, action):
        return await self.inner.authorize_incident(principal, incident_id, action)

    async def get_incident(self, incident_id):
        return await self.inner.get_incident(incident_id)

    async def get_assets(self, incident_id):
        return await self.inner.get_assets(incident_id)

    async def get_dependencies(self, incident_id):
        return await self.inner.get_dependencies(incident_id)

    async def get_open_tasks(self, incident_id):
        return await self.inner.get_open_tasks(incident_id)

    async def get_evidence_summaries(self, incident_id):
        return await self.inner.get_evidence_summaries(incident_id)

    async def ready(self):
        return await self.inner.ready()

    async def submit_recommendation(self, *, recommendation, requested_by, idempotency_key):
        self.submissions.append(
            {
                "recommendation": recommendation.model_dump(mode="json"),
                "requested_by": requested_by,
                "idempotency_key": idempotency_key,
            }
        )
        return await self.inner.submit_recommendation(
            recommendation=recommendation,
            requested_by=requested_by,
            idempotency_key=idempotency_key,
        )

    async def aclose(self):
        await self.inner.aclose()


def make_recording_app(app_factory, state):
    from app.backend import MemoryBackendClient

    backend = RecordingBackend(MemoryBackendClient(state=state))
    application = app_factory(backend_state=state)
    # Replace the backend and runtime backend reference for the submission path.
    application.state.backend = backend
    application.state.runtime.backend = backend
    application.state.runtime.agent.backend = backend
    return application, backend
