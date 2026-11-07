"""Simulator determinism, invariants, tamper detection, and CLI."""

from __future__ import annotations

import copy
import json

import pytest

from simulator.__main__ import main
from simulator.run import inject_state, reset_state, run_scenario, status, verify
from simulator.seed import build_state, load_scenario, verify_state

INJECTED_HASH = "6aad55610eb74e8744b0f137c6f58a7af6f1750ca5ff316d82d582d133ee4d5c"


def test_scenario_loads_with_expected_identity(scenario):
    assert scenario["schema_version"] == "1.0"
    assert scenario["scenario_id"] == "hospital_ransomware_v1"
    assert scenario["fictional"] is True
    assert scenario["organization"]["id"] == "org_riverbend_001"
    assert scenario["incident"]["id"] == "inc_riverbend_ransomware_001"


def test_injected_state_is_deterministic(scenario):
    first = build_state(scenario, phase="injected")
    second = build_state(copy.deepcopy(scenario), phase="injected")

    assert first == second
    assert first["integrity"]["state_sha256"] == INJECTED_HASH
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


@pytest.mark.parametrize(
    ("phase", "expected"),
    [
        (
            "baseline",
            {
                "assets": 12,
                "services": 3,
                "service_dependencies": 8,
                "users": 4,
                "memberships": 4,
                "data_scopes": 3,
                "tasks": 2,
                "evidence_references": 6,
                "audit_events": 6,
                "operational_impacts": 0,
            },
        ),
        (
            "injected",
            {
                "assets": 12,
                "services": 3,
                "service_dependencies": 8,
                "users": 4,
                "memberships": 4,
                "data_scopes": 3,
                "tasks": 6,
                "evidence_references": 12,
                "audit_events": 16,
                "operational_impacts": 3,
            },
        ),
    ],
)
def test_phase_counts_and_verification(scenario, phase, expected):
    state = build_state(scenario, phase=phase)
    result = verify_state(state)

    assert result["ok"] is True, result["errors"]
    assert result["counts"] == expected
    assert result["phase"] == phase


def test_uncertainty_and_exercise_invariants(state):
    assert state["fictional"] is True
    assert state["exercise"]["label"] == "EXERCISE"
    assert all(scope["exfiltration_status"] == "UNKNOWN" for scope in state["data_scopes"])
    for collection in ("tasks", "evidence_references", "audit_events", "operational_impacts"):
        assert all(record["exercise_label"] == "EXERCISE" for record in state[collection])
    assert all(user["auth_identity"].endswith(".invalid") for user in state["users"])


def test_confirming_exfiltration_is_detected(state):
    state["data_scopes"][0]["exfiltration_status"] = "CONFIRMED"

    result = verify_state(state)

    assert result["ok"] is False
    assert any("exfiltration status must remain UNKNOWN" in item for item in result["errors"])
    assert any("state integrity hash mismatch" in item for item in result["errors"])


def test_audit_chain_tamper_is_detected(state):
    state["audit_events"][3]["metadata"]["tampered"] = True

    result = verify_state(state)

    assert result["ok"] is False
    assert any("audit chain hash mismatch" in item for item in result["errors"])


def test_invalid_evidence_hash_is_detected(state):
    state["evidence_references"][0]["sha256"] = "zz"

    result = verify_state(state)

    assert result["ok"] is False
    assert any("invalid sha256" in item for item in result["errors"])
    assert any("state integrity hash mismatch" in item for item in result["errors"])


def test_state_hash_tamper_is_detected(state):
    state["integrity"]["state_sha256"] = "0" * 64

    result = verify_state(state)

    assert result["ok"] is False
    assert any("state integrity hash mismatch" in item for item in result["errors"])


def test_reset_inject_and_run_use_isolated_files(tmp_path):
    path = tmp_path / "state.json"

    reset = reset_state(state_path=path)
    assert reset["ok"] is True
    assert reset["phase"] == "baseline"
    assert reset["counts"]["tasks"] == 2

    injected = inject_state(state_path=path)
    assert injected["ok"] is True
    assert injected["phase"] == "injected"
    assert injected["already_injected"] is False

    again = inject_state(state_path=path)
    assert again["already_injected"] is True
    assert again["state_sha256"] == injected["state_sha256"]

    full = run_scenario(state_path=path)
    assert full["state_sha256"] == INJECTED_HASH

    info = status(state_path=path)
    assert info["ok"] is True
    assert info["exfiltration_status"] == ["UNKNOWN"]

    checked = verify(state_path=path)
    assert checked["ok"] is True


def test_unknown_scenario_is_rejected(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_scenario(tmp_path / "missing.json")


def test_unsupported_scenario_schema_is_rejected(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"schema_version": "2.0"}), encoding="utf-8")

    with pytest.raises(ValueError):
        load_scenario(path)


def test_invalid_phase_is_rejected(scenario):
    with pytest.raises(ValueError):
        build_state(scenario, phase="production")


def test_cli_run_and_verify(tmp_path, capsys):
    path = tmp_path / "cli-state.json"

    assert main(["--state", str(path), "run"]) == 0
    assert main(["--state", str(path), "verify"]) == 0
    assert main(["--state", str(path), "status"]) == 0

    output = capsys.readouterr().out
    assert '"ok": true' in output
    assert "EXERCISE" in output
