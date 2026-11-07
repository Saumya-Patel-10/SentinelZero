"""Deterministic synthetic hospital ransomware state builder.

Everything here is fictional and labeled EXERCISE. The builder never contacts a
real system and never performs destructive actions. Timestamps come from the
scenario, not the wall clock, so repeated builds are byte-for-byte identical.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any

SCENARIO_DIR = Path(__file__).resolve().parent / "scenarios"
DEFAULT_SCENARIO = "hospital_ransomware.json"
PHASES = ("baseline", "injected")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_scenario(name_or_path: str | Path | None = None) -> dict[str, Any]:
    target = name_or_path or DEFAULT_SCENARIO
    path = Path(target)
    if not path.is_absolute() and not path.exists():
        candidate = SCENARIO_DIR / path
        if candidate.suffix == "":
            candidate = candidate.with_suffix(".json")
        path = candidate
    if not path.exists():
        raise FileNotFoundError(f"Unknown simulator scenario: {target}")
    with path.open("r", encoding="utf-8") as handle:
        scenario = json.load(handle)
    if not isinstance(scenario, dict) or scenario.get("schema_version") != "1.0":
        raise ValueError("Unsupported scenario schema")
    return scenario


def _phase_records(records: list[dict[str, Any]], phase: str) -> list[dict[str, Any]]:
    if phase == "injected":
        return [copy.deepcopy(item) for item in records]
    return [copy.deepcopy(item) for item in records if item.get("phase") == "baseline"]


def _fill_evidence_hashes(records: list[dict[str, Any]]) -> None:
    for record in records:
        if record.get("sha256") in (None, "", "auto"):
            record["sha256"] = sha256_text(f"EXERCISE:{record.get('id', 'unknown')}")
        digest = str(record["sha256"])
        if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            raise ValueError(f"Invalid evidence hash for {record.get('id')}")


def _chain_audit_events(events: list[dict[str, Any]]) -> None:
    previous = "0" * 64
    for event in events:
        event["previous_hash"] = previous
        payload = {key: value for key, value in event.items() if key != "event_hash"}
        event["event_hash"] = sha256_text(previous + canonical_json(payload))
        previous = event["event_hash"]


def compute_state_hash(state: dict[str, Any]) -> str:
    payload = {key: value for key, value in state.items() if key != "integrity"}
    return sha256_text(canonical_json(payload))


def build_state(scenario: dict[str, Any], phase: str = "baseline") -> dict[str, Any]:
    if phase not in PHASES:
        raise ValueError(f"phase must be one of {PHASES}")

    incident = copy.deepcopy(scenario["incident"])
    assets = copy.deepcopy(scenario["assets"])
    services = copy.deepcopy(scenario["services"])
    data_scopes = copy.deepcopy(scenario["data_scopes"])
    impacts: list[dict[str, Any]] = []

    if phase == "injected":
        injection = scenario.get("injection", {})
        incident.update(copy.deepcopy(injection.get("incident_updates", {})))
        for asset in assets:
            asset.update(copy.deepcopy(injection.get("asset_updates", {}).get(asset["id"], {})))
        for service in services:
            service.update(copy.deepcopy(injection.get("service_updates", {}).get(service["id"], {})))
        for scope in data_scopes:
            scope.update(copy.deepcopy(injection.get("data_scope_updates", {}).get(scope["id"], {})))
        impacts = [copy.deepcopy(item) for item in injection.get("operational_impacts", [])]

    evidence = _phase_records(scenario["evidence_references"], phase)
    _fill_evidence_hashes(evidence)
    events = _phase_records(scenario["audit_events"], phase)
    _chain_audit_events(events)

    state: dict[str, Any] = {
        "schema_version": "1.0",
        "state_version": 1,
        "scenario_id": scenario["scenario_id"],
        "scenario_name": scenario["name"],
        "phase": phase,
        "fictional": True,
        "labels": list(scenario.get("labels", ["EXERCISE", "SYNTHETIC"])),
        "exercise": copy.deepcopy(scenario["exercise"]),
        "organization": copy.deepcopy(scenario["organization"]),
        "users": copy.deepcopy(scenario["users"]),
        "memberships": copy.deepcopy(scenario["memberships"]),
        "incidents": [incident],
        "assets": assets,
        "services": services,
        "service_dependencies": copy.deepcopy(scenario["service_dependencies"]),
        "operational_impacts": impacts,
        "data_scopes": data_scopes,
        "tasks": _phase_records(scenario["tasks"], phase),
        "messages": _phase_records(scenario["messages"], phase),
        "evidence_references": evidence,
        "audit_events": events,
        "demo": {
            "organization_id": scenario["organization"]["id"],
            "incident_id": scenario["incident"]["id"],
            "rumored_exfiltration": "UNKNOWN",
        },
        "integrity": {},
    }
    # Force the uncertainty invariant even if a future scenario edit drifts.
    for scope in state["data_scopes"]:
        if "exfiltration_status" not in scope:
            scope["exfiltration_status"] = "UNKNOWN"
    state["integrity"] = {
        "algorithm": "sha256",
        "canonicalization": "json-sort-keys-utf8",
        "state_sha256": compute_state_hash(state),
    }
    return state


def verify_state(state: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    phase = state.get("phase")
    if phase not in PHASES:
        errors.append("invalid phase")
    expected = {
        "assets": 12,
        "services": 3,
        "service_dependencies": 8,
        "users": 4,
        "memberships": 4,
        "data_scopes": 3,
        "tasks": 2 if phase == "baseline" else 6,
        "evidence_references": 6 if phase == "baseline" else 12,
        "audit_events": 6 if phase == "baseline" else 16,
        "operational_impacts": 0 if phase == "baseline" else 3,
    }
    counts = {key: len(state.get(key, [])) for key in expected}
    for key, value in expected.items():
        if counts.get(key) != value:
            errors.append(f"{key} expected {value}, found {counts.get(key)}")

    if state.get("exercise", {}).get("label") != "EXERCISE":
        errors.append("top-level exercise label missing")
    if state.get("fictional") is not True:
        errors.append("fictional flag missing")

    incidents = state.get("incidents", [])
    if len(incidents) != 1:
        errors.append("exactly one incident is required")
    elif incidents[0].get("exercise_label") != "EXERCISE":
        errors.append("incident exercise label missing")

    for scope in state.get("data_scopes", []):
        if scope.get("exfiltration_status") != "UNKNOWN":
            errors.append(f"{scope.get('id')} exfiltration status must remain UNKNOWN")
    for collection in ("tasks", "evidence_references", "audit_events", "operational_impacts"):
        for record in state.get(collection, []):
            if record.get("exercise_label") != "EXERCISE":
                errors.append(f"{collection}:{record.get('id')} missing EXERCISE label")

    for evidence in state.get("evidence_references", []):
        digest = str(evidence.get("sha256", ""))
        if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            errors.append(f"{evidence.get('id')} has an invalid sha256")

    previous = "0" * 64
    for event in state.get("audit_events", []):
        if event.get("previous_hash") != previous:
            errors.append(f"{event.get('id')} audit chain previous_hash mismatch")
        payload = {key: value for key, value in event.items() if key != "event_hash"}
        expected_hash = sha256_text(previous + canonical_json(payload))
        if event.get("event_hash") != expected_hash:
            errors.append(f"{event.get('id')} audit chain hash mismatch")
        previous = str(event.get("event_hash", ""))

    expected_state_hash = compute_state_hash(state)
    if state.get("integrity", {}).get("state_sha256") != expected_state_hash:
        errors.append("state integrity hash mismatch")

    for user in state.get("users", []):
        identity = str(user.get("auth_identity", ""))
        if not identity.endswith(".invalid"):
            errors.append("user identities must use the reserved .invalid domain")

    return {
        "ok": not errors,
        "phase": phase,
        "scenario_id": state.get("scenario_id"),
        "counts": counts,
        "state_sha256": expected_state_hash,
        "errors": errors,
    }
