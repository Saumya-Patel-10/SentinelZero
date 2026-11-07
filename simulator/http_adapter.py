"""MOCK HTTP adapter for Agent 1. Not used by the demo.

The simulator can already produce deterministic fixtures. Once Agent 1 publishes
its frozen service auth + reducer contract, implement this adapter and mark the
contract status VERIFIED. It must never be used to touch real assets.
"""

from __future__ import annotations

from typing import Any

from simulator.contract import (
    AI_FORBIDDEN_REDUCERS,
    CONTRACT_STATUS,
    REQUIRED_READ_ENDPOINTS,
    RealBackendAdapterNotImplemented,
)


class HttpSimulatorAdapter:
    """Placeholder that fails loudly rather than pretending to integrate."""

    contract_status = CONTRACT_STATUS
    verify_required = True

    def __init__(self, base_url: str, service_token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._service_token = service_token

    @property
    def required_endpoints(self) -> dict[str, str]:
        return dict(REQUIRED_READ_ENDPOINTS)

    @property
    def forbidden_reducers(self) -> tuple[str, ...]:
        return AI_FORBIDDEN_REDUCERS

    def push(self, state: dict[str, Any]) -> None:
        raise RealBackendAdapterNotImplemented(
            "MOCK: Agent 1 HTTP/reducer contract is not frozen. Use file transport "
            "(simulator/.state/state.json) until CONTRACTS_FROZEN is published."
        )
