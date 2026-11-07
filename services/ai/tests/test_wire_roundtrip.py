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
from app.llm.types import (
    ProviderNotConfigured,
    ProviderProtocolError,
)
from conftest import (
    INCIDENT,
    FakeNemotron,
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


async def test_openai_compatible_tool_round_trip(app_factory, client_factory):
    settings = _live_settings()
    fake = FakeNemotron(
        [
            FakeNemotron.tool_turn(read_calls()),
            FakeNemotron.final_turn(recommendation_payload()),
        ]
    )
    provider = _provider(settings, fake)
    app = app_factory(settings=settings, provider=provider)
    client = await client_factory(app)
    headers = auth_headers()

    accepted = await client.post(f"/v1/incidents/{INCIDENT}/analyze", json={}, headers=headers)

    assert accepted.status_code == 202
    body = accepted.json()
    assert body["provider_mode"] == "live"
    assert body["inference_label"] == "LIVE_NVIDIA_INFERENCE"
    assert body["live_inference"] is True
    assert "LIVE NVIDIA" in body["notice"]

    run = await wait_for_run(client, body["run_id"], headers)

    assert run["status"] == "COMPLETED"
    assert run["inference_label"] == "LIVE_NVIDIA_INFERENCE"
    assert len(run["provider_calls"]) == 2
    assert run["recommendation"]["approval_status"] == "PENDING_HUMAN_APPROVAL"

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
    assert run["recommendation"]["inference_label"] == "LIVE_NVIDIA_INFERENCE"


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


async def test_custom_endpoint_is_not_labeled_live_nvidia(app_factory, client_factory):
    settings = _live_settings(nvidia_base_url="https://llm.internal.example/v1")
    fake = FakeNemotron([FakeNemotron.final_turn(recommendation_payload())])
    provider = _provider(settings, fake)
    app = app_factory(settings=settings, provider=provider)
    client = await client_factory(app)

    response = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze", json={}, headers=auth_headers()
    )

    assert response.status_code == 202
    body = response.json()
    assert body["inference_label"] == "UNVERIFIED_PROVIDER"
    assert body["live_inference"] is False
    assert "not attested" in body["notice"]
