"""Atomic deterministic simulator state storage."""

from __future__ import annotations

import json
import os
from pathlib import Path

from simulator.seed import canonical_json

DEFAULT_STATE_PATH = Path(__file__).resolve().parent / ".state" / "state.json"


def write_state(state: dict, path: str | Path | None = None) -> Path:
    target = Path(path) if path else DEFAULT_STATE_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(state, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(serialized, encoding="utf-8", newline="\n")
    os.replace(temporary, target)
    return target


def read_state(path: str | Path | None = None) -> dict:
    target = Path(path) if path else DEFAULT_STATE_PATH
    with target.open("r", encoding="utf-8") as handle:
        state = json.load(handle)
    if not isinstance(state, dict):
        raise ValueError("Simulator state must be a JSON object")
    return state


def state_digest(state: dict) -> str:
    return __import__("hashlib").sha256(canonical_json(state).encode("utf-8")).hexdigest()
