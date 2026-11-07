"""Rate limiting and per-user concurrency bounds."""

from __future__ import annotations

import asyncio

from app.llm.types import ProviderDescriptor
from app.security.rate_limit import ConcurrentRunLimiter, RateLimiter
from conftest import INCIDENT, auth_headers

ANALYZE = f"/v1/incidents/{INCIDENT}/analyze"


class _Clock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


async def test_token_bucket_refills_and_blocks():
    clock = _Clock()
    limiter = RateLimiter(per_minute=2, burst=1, clock=clock)  # capacity 3

    for _ in range(3):
        allowed, _ = await limiter.check("user")
        assert allowed is True

    allowed, retry_after = await limiter.check("user")
    assert allowed is False
    assert retry_after >= 1

    clock.value += 30.0  # two minutes of refill at 2/min -> 1 token
    allowed, _ = await limiter.check("user")
    assert allowed is True


async def test_buckets_are_per_key():
    limiter = RateLimiter(per_minute=1, burst=0)

    assert (await limiter.check("a"))[0] is True
    assert (await limiter.check("a"))[0] is False
    assert (await limiter.check("b"))[0] is True


async def test_concurrent_limiter_acquire_release():
    limiter = ConcurrentRunLimiter(1)

    assert await limiter.acquire("user") is True
    assert await limiter.acquire("user") is False
    await limiter.release("user")
    assert await limiter.acquire("user") is True
    await limiter.release("user")
    await limiter.release("user")  # underflow is safe


async def test_endpoint_rate_limit_returns_429(app_factory, client_factory):
    from conftest import test_settings

    app = app_factory(settings=test_settings(rate_limit_per_minute=1, rate_limit_burst=0))
    client = await client_factory(app)
    headers = auth_headers()

    first = await client.post(ANALYZE, json={}, headers=headers)
    second = await client.post(ANALYZE, json={}, headers=headers)

    assert first.status_code == 202
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "RATE_LIMITED"
    assert int(second.headers["retry-after"]) >= 1
    assert second.json()["error"]["details"]["retry_after_seconds"] >= 1


async def test_per_user_concurrency_limit_returns_429(app_factory, client_factory):
    from conftest import test_settings, wait_for_run

    class SlowProvider:
        descriptor = ProviderDescriptor(
            mode="scripted",
            endpoint_class="SIMULATED_SCRIPTED",
            model_identifier="slow-test",
            inference_label="SIMULATED_MODEL_OUTPUT",
            configured=True,
        )

        async def complete(self, **kwargs):
            await asyncio.sleep(30)

        async def aclose(self):
            return None

    app = app_factory(
        settings=test_settings(
            max_concurrent_runs_per_user=1,
            rate_limit_per_minute=100,
            rate_limit_burst=10,
        ),
        provider=SlowProvider(),
    )
    client = await client_factory(app)
    headers = auth_headers()

    first = await client.post(ANALYZE, json={}, headers=headers)
    assert first.status_code == 202
    second = await client.post(ANALYZE, json={}, headers=headers)

    assert second.status_code == 429
    assert second.json()["error"]["code"] == "RATE_LIMITED"
    assert second.json()["error"]["message"].startswith("Too many concurrent")

    run_id = first.json()["run_id"]
    await client.post(f"/v1/agent-runs/{run_id}/cancel", headers=headers)
    await wait_for_run(client, run_id, headers)

    # The slot is released after the cancelled task finishes. Poll briefly; the
    # status flips to CANCELLED before the runtime `finally` block runs.
    third = None
    for _ in range(50):
        third = await client.post(ANALYZE, json={}, headers=headers)
        if third.status_code == 202:
            break
        await asyncio.sleep(0.02)
    assert third is not None and third.status_code == 202
