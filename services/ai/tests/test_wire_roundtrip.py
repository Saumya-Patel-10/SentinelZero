"""Wire-level NVIDIA OpenAI-compatible protocol tests.

These tests use an httpx MockTransport test double. They verify the *protocol* the
service speaks to a real Nemotron deployment, but they are NOT live inference.
"""

from __future__ import annotations

import json
import time

import httpx
import pytest

from app.llm.nemotron_client import NemotronProvider
from app.llm.types import ProviderNotConfigured, ProviderProtocolError
from conftest import (
    FakeNemotron,
    INCIDENT,
    ORG,
    auth_headers,
    read_calls,
    recommendation_payload,
    test_settings,
    wait_for_run,
)

NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"


def _live_settings(**overrides):
    values = {
        "provider_mode": "live",
        "nvidia_api_key": "nvapi-test-key-0123456789abcdef",
        "nvidia_base_url": "https://integrate.api.nvidia.com/v1",
        "nvidia_max_retries": 0,
    }
    values.update(overrides)
    return test_settings(**values)


def _provider(settings, fake: FakeNemotron) -> NemotronProvider:
    return NemotronProvider(settings, transport=fake.transport)


async def test_openai_compatible_tool_round_trip(app_factory, client_factory, stdb):
    settings = _live_settings(agent_mode="single")
    fake = FakeNemotron(
        [
            FakeNemotron.tool_turn(read_calls()),
            FakeNemotron.final_turn(recommendation_payload()),
        ]
    )
    provider = _provider(settings, fake)
    run_id = "run_wire_roundtrip_001"
    stdb.set_run(run_id, status="REQUESTED", inference_mode="LIVE", model_identifier="nvidia/nemotron-3-super-120b-a12b")
    app = app_factory(settings=settings, provider=provider)
    client = await client_factory(app)
    headers = auth_headers()

    accepted = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze",
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )

    assert accepted.status_code == 202
    body = accepted.json()
    assert body["run_id"] == run_id
    assert body["status"] == "RUNNING"
    assert body["inference_mode"] == "LIVE"
    assert body["model_identifier"] == "nvidia/nemotron-3-super-120b-a12b"

    run = await wait_for_run(client, run_id, headers)

    assert run["status"] == "COMPLETED"
    assert run["inference_mode"] == "LIVE"
    assert len(run["provider_calls"]) == 2
    assert run["recommendation"]["status"] == "PENDING"

    # --- request wire shape -------------------------------------------------
    assert len(fake.requests) == 2
    first, second = fake.requests
    assert first["method"] == "POST"
    assert first["url"] == NVIDIA_URL
    assert first["headers"]["authorization"] == "Bearer nvapi-test-key-0123456789abcdef"
    payload = first["body"]
    assert payload["model"] == "nvidia/nemotron-3-super-120b-a12b"
    assert payload["stream"] is False
    assert payload["tool_choice"] == "auto"
    assert payload["parallel_tool_calls"] is True
    assert {tool["function"]["name"] for tool in payload["tools"]} == {
        "get_incident",
        "get_assets",
        "get_dependencies",
        "get_open_tasks",
        "get_evidence_summaries",
        "propose_task",
        "query_threat_intelligence",
    }
    assert all(tool["type"] == "function" for tool in payload["tools"])
    assert "response_format" not in payload

    # --- follow-up shape ----------------------------------------------------
    followup = second["body"]
    assert followup["response_format"]["type"] == "json_schema"
    roles = [message["role"] for message in followup["messages"]]
    assert roles[0] == "system"
    assert roles[1] == "user"
    assistant = next(m for m in followup["messages"] if m["role"] == "assistant")
    assert len(assistant["tool_calls"]) == 3
    tool_messages = [m for m in followup["messages"] if m["role"] == "tool"]
    assert len(tool_messages) == 3
    assert {m["tool_call_id"] for m in tool_messages} == {
        "call_inc",
        "call_assets",
        "call_evidence",
    }
    for message in tool_messages:
        assert set(json.loads(message["content"])) >= {"tool", "data", "exercise_label"}

    assert run["tool_calls"]
    assert run["recommendation"]["inference_mode"] == "LIVE"


def _orchestrated_outputs():
    from app.agents.subagents import (
        CommunicationsOutput,
        ContainmentOutput,
        ImpactMapping,
        ImpactOutput,
        TriageOutput,
    )
    from app.schemas import FactDraft, ProposedActionDraft, UncertaintyDraft

    uncertainty = UncertaintyDraft(
        question="Was data exfiltrated?",
        why_unknown="No tool result in this exercise shows that data left the environment.",
        impact_if_true="Notification obligations could expand.",
        resolution_step="Validate network egress and database access evidence.",
        related_evidence_ids=["ev_edr_alert"],
    )
    triage = TriageOutput(
        headline="Wire triage: exfiltration stays UNKNOWN",
        summary="Wire-test triage. The EDR evidence was returned by the backend and was not upgraded.",
        priority="P1",
        facts=[
            FactDraft(
                statement="An EDR alert is recorded for the affected exercise system.",
                evidence_ids=["ev_edr_alert"],
                verification="SUSPECTED",
                confidence=0.9,
            )
        ],
        uncertainties=[uncertainty],
    )
    impact = ImpactOutput(
        summary="Wire-test impact. The asset keeps the compromise and exfiltration status the backend reported.",
        mappings=[
            ImpactMapping(
                asset_id="ast_ehr_db",
                service_id=None,
                human_unit="Clinical operations team",
                compromise="SUSPECTED",
                exfiltration="UNKNOWN",
                evidence_ids=["ev_edr_alert"],
            )
        ],
        uncertainties=[uncertainty],
    )
    containment = ContainmentOutput(
        summary="Wire-test containment. The proposal is pending human approval and was not executed.",
        rationale="Preserve evidence before any recovery change. A commander must approve it.",
    )
    communications = CommunicationsOutput(
        audience="INCIDENT_COMMAND",
        sitrep=(
            "Wire-test situation report. Known: exercise evidence ev_edr_alert is on file. "
            "Unknown: whether data was exfiltrated. Pending: one containment proposal awaits approval. "
            "Next update: after commander review. This draft was not sent."
        ),
    )
    proposal = ProposedActionDraft(
        title="Preserve and hash evidence for the incident",
        description="Collect and hash the listed evidence. Do not delete or modify source systems.",
        priority="P1",
        rationale="Evidence must be preserved before recovery changes systems.",
        evidence_ids=["ev_edr_alert"],
    )
    return triage, impact, containment, communications, proposal


async def test_orchestrated_openai_compatible_tool_round_trip(app_factory, client_factory, stdb):
    """Each sub-agent is offered only its allowlist, then a schema-constrained final turn."""

    triage, impact, containment, communications, proposal = _orchestrated_outputs()
    settings = _live_settings()
    fake = FakeNemotron(
        [
            FakeNemotron.tool_turn(
                [
                    ("call_triage_incident", "get_incident", "{}"),
                    ("call_triage_evidence", "get_evidence_summaries", "{}"),
                ]
            ),
            FakeNemotron.final_turn(triage.model_dump(mode="json")),
            FakeNemotron.tool_turn(
                [
                    ("call_impact_assets", "get_assets", "{}"),
                    ("call_impact_deps", "get_dependencies", "{}"),
                ]
            ),
            FakeNemotron.final_turn(impact.model_dump(mode="json")),
            FakeNemotron.tool_turn(
                [
                    ("call_contain_tasks", "get_open_tasks", "{}"),
                    (
                        "call_contain_propose",
                        "propose_task",
                        json.dumps(proposal.model_dump(mode="json")),
                    ),
                ]
            ),
            FakeNemotron.final_turn(containment.model_dump(mode="json")),
            FakeNemotron.final_turn(communications.model_dump(mode="json")),
        ]
    )
    provider = _provider(settings, fake)
    run_id = "run_wire_orchestrated_001"
    stdb.set_run(
        run_id,
        status="REQUESTED",
        inference_mode="LIVE",
        model_identifier="nvidia/nemotron-3-super-120b-a12b",
    )
    app = app_factory(settings=settings, provider=provider)
    client = await client_factory(app)
    headers = auth_headers()

    accepted = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze",
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )
    assert accepted.status_code == 202
    assert accepted.json()["inference_mode"] == "LIVE"

    run = await wait_for_run(client, run_id, headers)
    assert run["status"] == "COMPLETED", run.get("error_message") or run.get("error_category")
    assert run["agent_mode"] == "orchestrated"
    assert [item["name"] for item in run["subagents"]] == [
        "triage",
        "impact",
        "containment",
        "communications",
    ]
    assert all(item["status"] == "COMPLETED" for item in run["subagents"])
    assert all(len(item["summary"]) <= 600 for item in run["subagents"])
    assert run["sitrep"]
    assert len(run["sitrep"]) <= 2000
    assert run["recommendation"]["status"] == "PENDING"
    assert run["recommendation"]["requires_human_approval"] is True

    assert len(fake.requests) == 7
    bodies = [request["body"] for request in fake.requests]
    assert all(request["url"] == NVIDIA_URL for request in fake.requests)
    assert all(request["headers"]["authorization"].startswith("Bearer ") for request in fake.requests)

    triage_tools = {tool["function"]["name"] for tool in bodies[0]["tools"]}
    assert triage_tools == {"get_incident", "get_evidence_summaries"}
    assert "response_format" not in bodies[0]
    assert bodies[0]["tool_choice"] == "auto"
    assert "[sentinelzero-subagent:triage]" in bodies[0]["messages"][0]["content"]

    assert bodies[1]["response_format"]["json_schema"]["name"] == "sentinelzero_triage_output"
    triage_followups = [message for message in bodies[1]["messages"] if message["role"] == "tool"]
    assert {message["name"] for message in triage_followups} == {
        "get_incident",
        "get_evidence_summaries",
    }

    assert {tool["function"]["name"] for tool in bodies[2]["tools"]} == {
        "get_assets",
        "get_dependencies",
    }
    impact_user = next(message["content"] for message in bodies[2]["messages"] if message["role"] == "user")
    assert "<untrusted_prior_subagent_output>" in impact_user
    assert "</untrusted_prior_subagent_output>" in impact_user

    assert {tool["function"]["name"] for tool in bodies[4]["tools"]} == {
        "get_open_tasks",
        "propose_task",
    }
    assert "approve_task" not in {tool["function"]["name"] for tool in bodies[4]["tools"]}
    containment_followups = [message for message in bodies[5]["messages"] if message["role"] == "tool"]
    assert {message["name"] for message in containment_followups} == {"get_open_tasks", "propose_task"}

    assert "tools" not in bodies[6]
    assert bodies[6]["response_format"]["json_schema"]["name"] == "sentinelzero_communications_output"
    comms_user = next(message["content"] for message in bodies[6]["messages"] if message["role"] == "user")
    assert "<untrusted_prior_subagent_output>" in comms_user
    assert "[sentinelzero-subagent:communications]" in bodies[6]["messages"][0]["content"]


async def test_response_format_400_falls_back_without_format():
    fake = FakeNemotron(
        [
            httpx.Response(400, json={"error": "response_format unsupported"}),
            FakeNemotron.final_turn(recommendation_payload()),
        ]
    )
    settings = _live_settings(nvidia_max_retries=1)
    provider = _provider(settings, fake)

    turn = await provider.complete(
        messages=[{"role": "user", "content": "analyze"}],
        tools=[],
        response_format={"type": "json_schema", "json_schema": {"name": "x", "schema": {}}},
        deadline=time.monotonic() + 5,
        cancel_event=None,
    )

    assert turn.content is not None
    assert "response_format" in fake.requests[0]["body"]
    assert "response_format" not in fake.requests[1]["body"]
    assert turn.response_format_used is False


async def test_provider_accepts_content_parts_and_dict_arguments():
    response = httpx.Response(
        200,
        json={
            "id": "chatcmpl-parts",
            "model": "nvidia/nemotron-3-super-120b-a12b",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "partial"}],
                        "tool_calls": [
                            {
                                "id": "call_dict",
                                "type": "function",
                                "function": {
                                    "name": "get_incident",
                                    "arguments": {"incident_id": "ignored-by-registry"},
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        },
        headers={"x-request-id": "req-parts"},
    )
    fake = FakeNemotron([response])
    provider = _provider(_live_settings(), fake)

    turn = await provider.complete(
        messages=[{"role": "user", "content": "go"}],
        tools=[],
        response_format=None,
        deadline=time.monotonic() + 5,
        cancel_event=None,
    )

    assert turn.content == "partial"
    assert turn.tool_calls[0].arguments_json == '{"incident_id":"ignored-by-registry"}'
    assert turn.provider_request_id == "req-parts"
    assert turn.usage == {"input_tokens": 10, "output_tokens": 2}


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"not-json", headers={"content-type": "application/json"}),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"choices": [{"message": None}]}),
        httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "x",
                            "tool_calls": [
                                {
                                    "id": f"call_{i}",
                                    "type": "function",
                                    "function": {"name": "get_incident", "arguments": "{}"},
                                }
                                for i in range(17)
                            ],
                        }
                    }
                ]
            },
        ),
    ],
)
async def test_malformed_provider_responses_are_protocol_errors(response):
    fake = FakeNemotron([response])
    provider = _provider(_live_settings(), fake)

    with pytest.raises(ProviderProtocolError):
        await provider.complete(
            messages=[{"role": "user", "content": "go"}],
            tools=[],
            response_format=None,
            deadline=time.monotonic() + 5,
            cancel_event=None,
        )


async def test_unconfigured_provider_fails_closed():
    settings = _live_settings(nvidia_api_key=None)
    provider = NemotronProvider(settings)

    assert provider.descriptor.configured is False
    with pytest.raises(ProviderNotConfigured):
        await provider.complete(
            messages=[{"role": "user", "content": "go"}],
            tools=[],
            response_format=None,
            deadline=time.monotonic() + 5,
            cancel_event=None,
        )
    await provider.aclose()


async def test_custom_endpoint_is_not_labeled_live_nvidia(app_factory, client_factory, stdb):
    settings = _live_settings(nvidia_base_url="https://llm.internal.example/v1")
    fake = FakeNemotron([FakeNemotron.final_turn(recommendation_payload())])
    provider = _provider(settings, fake)
    run_id = "run_custom_001"
    stdb.set_run(run_id, status="REQUESTED", inference_mode="FIXTURE")
    app = app_factory(settings=settings, provider=provider)
    client = await client_factory(app)

    response = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze",
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=auth_headers(),
    )

    assert response.status_code == 202
    body = response.json()
    assert body["inference_mode"] == "FIXTURE"
    assert body["model_identifier"] == "nvidia/nemotron-3-super-120b-a12b"
