"""Single-process token-bucket rate limiting.

Multi-instance deployments need a shared limiter (Redis or the backend). This
local limiter still protects a single AI deployment and makes tests deterministic.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


class RateLimiter:
    def __init__(
        self,
        *,
        per_minute: int,
        burst: int = 0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.capacity = float(per_minute + burst)
        self.refill_per_second = per_minute / 60.0
        self._clock = clock
        self._buckets: dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""

        async with self._lock:
            now = self._clock()
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=self.capacity, updated_at=now)
                self._buckets[key] = bucket
            else:
                elapsed = max(0.0, now - bucket.updated_at)
                bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.refill_per_second)
                bucket.updated_at = now

            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                # Opportunistic cleanup of stale buckets.
                if len(self._buckets) > 2_000:
                    cutoff = now - 600
                    self._buckets = {
                        k: v for k, v in self._buckets.items() if v.updated_at >= cutoff
                    }
                return True, 0

            missing = 1.0 - bucket.tokens
            retry_after = max(1, math.ceil(missing / self.refill_per_second))
            return False, retry_after


class ConcurrentRunLimiter:
    """Bounded concurrent analyses per caller within one service process."""

    def __init__(self, max_per_user: int) -> None:
        self.max_per_user = max_per_user
        self._active: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, key: str) -> bool:
        async with self._lock:
            current = self._active.get(key, 0)
            if current >= self.max_per_user:
                return False
            self._active[key] = current + 1
            return True

    async def release(self, key: str) -> None:
        async with self._lock:
            current = self._active.get(key, 0)
            if current <= 1:
                self._active.pop(key, None)
            else:
                self._active[key] = current - 1
