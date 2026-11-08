"""Shared pytest fixtures and fake provider/backend helpers.

The fake provider is a wire-level HTTP test double, never a production fallback.
The fake SpacetimeDB backend uses httpx.MockTransport to simulate the
POST {STDB_URI}/v1/database/{DB}/call/{name} API (contract v1.1.0, section 5.3).

Every run created with the scripted provider is labeled SIMULATED_MODEL_OUTPUT.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

import httpx
import pytest

from app.auth import mint_test_token
from app.backend import SpacetimeDBBackendClient
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
        "provider_mode": "scripted",
        "agent_mode": "orchestrated",
        "stdb_db_name": "sentinelzero",
        "backend_service_token": "test-service-token",
        "rate_limit_per_minute": 100,
        "rate_limit_burst": 10,
        "max_concurrent_runs_per_user": 5,
        "run_deadline_seconds": 20.0,
        "nvidia_max_retries": 0,
        "max_stored_runs": 100,
    }
    base.update(overrides)
    return Settings(**base)


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


# ---------------------------------------------------------------------------
# Fake SpacetimeDB HTTP API
# ---------------------------------------------------------------------------


class FakeSpacetimeDB:
    """Simulates the SpacetimeDB call endpoint for tests.

    Register handlers with ``on("procedure_name", handler)`` where handler
    receives the positional args list and returns a JSON-serializable result.
    For agent_get_* procedures, return [0, value] or [1, "CODE: detail"].
    """

    def __init__(self) -> None:
        self.handlers: dict[str, Callable[[list[Any]], Any]] = {}
        self.requests: list[dict[str, Any]] = []
        self.run_status: dict[str, str] = {}
        self.run_inference_mode: dict[str, str] = {}
        self.run_model_identifier: dict[str, str] = {}
        self._incident_id: dict[str, str] = {}
        self._organization_id: dict[str, str] = {}

    def on(self, name: str, handler: Callable[[list[Any]], Any]) -> None:
        self.handlers[name] = handler

    def set_run(
        self,
        run_id: str,
        *,
        status: str = "REQUESTED",
        inference_mode: str = "SIMULATED",
        model_identifier: str = "scripted-local-test-model",
        incident_id: str = INCIDENT,
        organization_id: str = ORG,
    ) -> None:
        self.run_status[run_id] = status
        self.run_inference_mode[run_id] = inference_mode
        self.run_model_identifier[run_id] = model_identifier
        self._incident_id[run_id] = incident_id
        self._organization_id[run_id] = organization_id

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        path = request.url.path
        # path is /call/{name}
        parts = path.strip("/").split("/")
        name = parts[-1] if parts else ""
        self.requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": body,
            }
        )
        handler = self.handlers.get(name)
        if handler is None:
            return httpx.Response(404, text=f"unknown procedure {name}")
        try:
            result = handler(body if isinstance(body, list) else [])
        except Exception as exc:
            return httpx.Response(530, text=f"INTERNAL: {exc}")
        if name.startswith("agent_get_"):
            # result envelope: [0, value] or [1, "CODE: detail"]
            if isinstance(result, tuple) and len(result) == 2 and result[0] == 1:
                return httpx.Response(200, json=[1, result[1]])
            return httpx.Response(200, json=[0, result])
        return httpx.Response(200, json=result)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def make_fake_stdb() -> FakeSpacetimeDB:
    stdb = FakeSpacetimeDB()

    def verify_access(args: list[Any]) -> list[Any]:
        run_id = args[0] if args else "run_test"
        return [
            True,
            True,
            "ANALYST",
            run_id,
            stdb._incident_id.get(run_id, INCIDENT),
            stdb._organization_id.get(run_id, ORG),
            stdb.run_status.get(run_id, "REQUESTED"),
        ]

    # Default handlers. Status and incident come from set_run so a RUNNING or
    # cross-incident run is actually denied.
    stdb.on("verify_agent_run_access", verify_access)
    stdb.on("agent_claim_run", lambda args: None)
    stdb.on("agent_get_incident", lambda args: _fake_incident(args[0] if args else ""))
    stdb.on("agent_get_assets", lambda args: _fake_assets(args[0] if args else ""))
    stdb.on(
        "agent_get_dependencies",
        lambda args: _fake_dependencies(args[0] if args else ""),
    )
    stdb.on("agent_get_open_tasks", lambda args: _fake_tasks(args[0] if args else ""))
    stdb.on(
        "agent_get_evidence_summaries",
        lambda args: _fake_evidence(args[0] if args else ""),
    )
    stdb.on("agent_submit_recommendation", lambda args: f"rec_{args[0] if args else ''}")
    stdb.on("agent_complete_run", lambda args: None)

    return stdb


def _fake_incident(run_id: str) -> dict:
    return {
        "runId": run_id,
        "analysisType": "intake",
        "incidentId": INCIDENT,
        "title": "Suspected ransomware affecting clinical systems (EXERCISE)",
        "description": "Synthetic ransomware incident for testing.",
        "category": "RANSOMWARE",
        "severity": "CRITICAL",
        "status": "INVESTIGATING",
        "dataClass": "EXERCISE",
        "reportedAt": "2026-03-14T01:52:00Z",
        "detectedAt": "2026-03-14T01:47:00Z",
        "updatedAt": "2026-03-14T02:10:00Z",
    }


def _fake_assets(run_id: str) -> list[dict]:
    return [
        {
            "id": "ast_ehr_db",
            "name": "EHR DB (exercise)",
            "assetType": "DATABASE",
            "criticality": "CRITICAL",
            "compromiseStatus": "SUSPECTED",
            "availabilityStatus": "DEGRADED",
            "lastVerifiedAt": "2026-03-14T01:49:00Z",
            "dataScopes": [],
        }
    ]


def _fake_dependencies(run_id: str) -> dict:
    return {
        "services": [],
        "dependencies": [],
        "impacts": [],
    }


def _fake_tasks(run_id: str) -> list[dict]:
    return []


def _fake_evidence(run_id: str) -> list[dict]:
    return [
        {
            "id": "ev_edr_alert",
            "evidenceType": "EDR_ALERT",
            "source": "Exercise EDR console",
            "sha256": "auto",
            "classification": "INTERNAL",
            "description": "EDR alert for affected EHR application",
            "recordedAt": "2026-03-14T01:49:00Z",
        }
    ]


# ---------------------------------------------------------------------------
# App and client factories
# ---------------------------------------------------------------------------


@pytest.fixture()
def stdb() -> FakeSpacetimeDB:
    return make_fake_stdb()


@pytest.fixture()
async def app_factory(stdb: FakeSpacetimeDB):
    apps = []

    def make(
        *,
        settings: Settings | None = None,
        provider: Any | None = None,
    ):
        application = create_app(settings=settings or test_settings(), provider=provider)
        # Replace the backend with a SpacetimeDB client pointed at the fake.
        backend = SpacetimeDBBackendClient(
            application.state.settings, transport=stdb.transport
        )
        application.state.backend = backend
        application.state.runtime.backend = backend
        if provider is not None:
            application.state.provider = provider
            application.state.runtime.provider = provider
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
    include_action: bool = True,
    summary: str | None = None,
) -> dict:
    evidence_ids = evidence_ids or ["ev_edr_alert"]
    facts = [
        {
            "statement": "An EDR alert is recorded for the affected EHR application.",
            "evidence_ids": [evidence_ids[0]],
            "verification": "SUSPECTED",
            "confidence": 0.9,
        }
    ]
    actions = []
    if include_action:
        actions.append(
            {
                "title": "Preserve evidence for the incident",
                "description": "Preserve and hash authorized evidence; do not delete sources.",
                "priority": "P1",
                "rationale": "Evidence must be preserved before recovery.",
                "evidence_ids": [evidence_ids[0]],
                "uncertainties": [],
            }
        )
    return {
        "title": summary or "Suspected ransomware; exfiltration remains UNKNOWN.",
        "description": "Synthetic exercise recommendation for human approval.",
        "priority": "P1",
        "rationale": "Preserve evidence and investigate impact.",
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
        "proposed_actions": actions,
        "limitations": ["Test double response."],
    }


def read_calls() -> list[tuple[str, str, str]]:
    return [
        ("call_inc", "get_incident", "{}"),
        ("call_assets", "get_assets", "{}"),
        ("call_evidence", "get_evidence_summaries", "{}"),
    ]


# ---------------------------------------------------------------------------
# Fake Nemotron provider (OpenAI-compatible HTTP test double)
# ---------------------------------------------------------------------------


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
