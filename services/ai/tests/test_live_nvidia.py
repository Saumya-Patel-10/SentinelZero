"""LIVE NVIDIA inference verification (opt-in, skipped without credentials).

This is the only test that contacts the real NVIDIA endpoint. It is skipped unless
BOTH NVIDIA_API_KEY (or AI_NVIDIA_API_KEY) and AI_LIVE_TESTS=1 are set.

Run:
    $env:NVIDIA_API_KEY = "..."
    $env:AI_LIVE_TESTS = "1"
    python -m pytest -m live -q
"""

from __future__ import annotations

import os

import pytest

from app.llm.nemotron_client import NemotronProvider
from app.llm.types import ProviderDescriptor
from conftest import INCIDENT, auth_headers, test_settings, wait_for_run

KEY = os.environ.get("NVIDIA_API_KEY") or os.environ.get("AI_NVIDIA_API_KEY")
BASE_URL = os.environ.get("AI_NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
MODEL = os.environ.get("AI_NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b")


def _live_provider() -> tuple[NemotronProvider, object]:
    settings = test_settings(
        provider_mode="live",
        nvidia_api_key=KEY,
        nvidia_base_url=BASE_URL,
        nvidia_model=MODEL,
        nvidia_max_retries=1,
        run_deadline_seconds=180.0,
    )
    return NemotronProvider(settings), settings


@pytest.mark.live
@pytest.mark.skipif(not KEY, reason="NVIDIA_API_KEY is not configured")
@pytest.mark.skipif(
    os.environ.get("AI_LIVE_TESTS") != "1",
    reason="set AI_LIVE_TESTS=1 to explicitly allow paid live inference",
)
async def test_live_nemotron_tool_round_trip(app_factory, client_factory, stdb):
    provider, settings = _live_provider()
    descriptor = provider.descriptor
    assert descriptor.configured is True
    assert descriptor.inference_label == "LIVE_NVIDIA_INFERENCE"
    assert descriptor.endpoint_class == "NVIDIA_HOSTED"

    app = app_factory(settings=settings, provider=provider)
    client = await client_factory(app)
    headers = auth_headers()

    run_id = "run_live_nvidia_001"
    stdb.set_run(run_id, status="REQUESTED", inference_mode="LIVE", model_identifier=MODEL)
    accepted = await client.post(
        f"/v1/incidents/{INCIDENT}/analyze",
        json={"incident_id": INCIDENT, "run_id": run_id, "analysis_type": "intake"},
        headers=headers,
    )

    assert accepted.status_code == 202, accepted.text
    body = accepted.json()
    assert body["run_id"] == run_id
    assert body["inference_mode"] == "LIVE"
    assert body["model_identifier"] == MODEL

    run = await wait_for_run(client, run_id, headers, timeout=180.0)

    assert run["status"] == "COMPLETED", run.get("error_category") or run.get("error_message")
    assert run["inference_mode"] == "LIVE"
    assert run["truthfulness"]["live_inference"] is True
    assert len(run["provider_calls"]) >= 2
    assert run["tool_calls"], "the live model did not perform the required tool round trip"
    assert {call["tool_name"] for call in run["tool_calls"]} & {
        "get_incident",
        "get_assets",
        "get_dependencies",
        "get_open_tasks",
        "get_evidence_summaries",
    }
    recommendation = run["recommendation"]
    assert recommendation is not None
    assert recommendation["status"] == "PENDING"
    assert recommendation["requires_human_approval"] is True
    assert "nvapi-" not in str(run)


async def test_live_provider_descriptor_without_key_is_unconfigured():
    settings = test_settings(
        provider_mode="live",
        nvidia_api_key=None,
        nvidia_base_url="https://integrate.api.nvidia.com/v1",
    )
    provider = NemotronProvider(settings)

    assert provider.descriptor == ProviderDescriptor(
        mode="live",
        endpoint_class="NVIDIA_HOSTED",
        model_identifier=MODEL,
        inference_label="UNVERIFIED_PROVIDER",
        configured=False,
    )
    await provider.aclose()
