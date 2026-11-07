"""Simulator commands: reset, seed, inject, run, status, verify.

All commands are deterministic and offline. They never touch a real database or
host. ``run`` is the full demo-ready state; ``reset`` returns to a clean baseline.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from simulator.seed import build_state, load_scenario, verify_state
from simulator.store import DEFAULT_STATE_PATH, read_state, write_state


def reset_state(
    *, state_path: str | Path | None = None, scenario: str | Path | None = None
) -> dict[str, Any]:
    scenario_data = load_scenario(scenario)
    state = build_state(scenario_data, phase="baseline")
    path = write_state(state, state_path)
    return _result("reset", path, state, verify_state(state))


def seed_state(
    *, state_path: str | Path | None = None, scenario: str | Path | None = None
) -> dict[str, Any]:
    result = reset_state(state_path=state_path, scenario=scenario)
    result["command"] = "seed"
    return result


def inject_state(
    *, state_path: str | Path | None = None, scenario: str | Path | None = None
) -> dict[str, Any]:
    target = Path(state_path) if state_path else DEFAULT_STATE_PATH
    if target.exists():
        try:
            existing = read_state(target)
        except (OSError, ValueError):
            existing = None
        if existing and existing.get("phase") == "injected":
            return {
                **_result("inject", target, existing, verify_state(existing)),
                "already_injected": True,
            }
    scenario_data = load_scenario(scenario)
    state = build_state(scenario_data, phase="injected")
    path = write_state(state, target)
    return {**_result("inject", path, state, verify_state(state)), "already_injected": False}


def run_scenario(
    *, state_path: str | Path | None = None, scenario: str | Path | None = None
) -> dict[str, Any]:
    scenario_data = load_scenario(scenario)
    state = build_state(scenario_data, phase="injected")
    path = write_state(state, state_path)
    return _result("run", path, state, verify_state(state))


def status(*, state_path: str | Path | None = None) -> dict[str, Any]:
    state = read_state(state_path)
    verification = verify_state(state)
    return {
        "command": "status",
        "state_path": str(Path(state_path) if state_path else DEFAULT_STATE_PATH),
        "phase": state.get("phase"),
        "scenario_id": state.get("scenario_id"),
        "incident_id": state.get("demo", {}).get("incident_id"),
        "organization_id": state.get("demo", {}).get("organization_id"),
        "exercise_label": state.get("exercise", {}).get("label"),
        "exfiltration_status": sorted(
            {scope.get("exfiltration_status") for scope in state.get("data_scopes", [])}
        ),
        "counts": verification["counts"],
        "state_sha256": state.get("integrity", {}).get("state_sha256"),
        "ok": verification["ok"],
        "errors": verification["errors"],
    }


def verify(*, state_path: str | Path | None = None) -> dict[str, Any]:
    state = read_state(state_path)
    result = verify_state(state)
    result["command"] = "verify"
    result["state_path"] = str(Path(state_path) if state_path else DEFAULT_STATE_PATH)
    return result


def _result(command: str, path: Path, state: dict, verification: dict) -> dict[str, Any]:
    return {
        "command": command,
        "state_path": str(path),
        "phase": state.get("phase"),
        "scenario_id": state.get("scenario_id"),
        "incident_id": state.get("demo", {}).get("incident_id"),
        "organization_id": state.get("demo", {}).get("organization_id"),
        "exercise_label": state.get("exercise", {}).get("label"),
        "state_sha256": state.get("integrity", {}).get("state_sha256"),
        "counts": verification["counts"],
        "ok": verification["ok"],
        "errors": verification["errors"],
    }
