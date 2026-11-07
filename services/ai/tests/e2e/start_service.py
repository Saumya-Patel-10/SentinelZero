"""Start a scripted, simulator-backed AI service for Playwright.

The simulator state is synthetic EXERCISE data and the provider is explicitly
scripted (SIMULATED_MODEL_OUTPUT). This script is for local/e2e only.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AI_DIR = HERE.parents[1]
REPO_ROOT = HERE.parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(AI_DIR))

STATE_PATH = Path(
    os.environ.get(
        "AI_SIMULATOR_STATE_PATH",
        str(REPO_ROOT / "simulator" / ".state" / "state.json"),
    )
)
PORT = int(os.environ.get("AI_E2E_PORT", "8100"))

os.environ.setdefault("AI_ENVIRONMENT", "test")
os.environ.setdefault("AI_PROVIDER_MODE", "scripted")
os.environ.setdefault("AI_BACKEND_MODE", "memory")
os.environ.setdefault("AI_LOG_LEVEL", "WARNING")
os.environ.setdefault("AI_SIMULATOR_STATE_PATH", str(STATE_PATH))
os.environ.setdefault("AI_RATE_LIMIT_PER_MINUTE", "120")
os.environ.setdefault("AI_RATE_LIMIT_BURST", "20")

if not os.environ.get("AI_JWT_SECRET"):
    raise SystemExit("AI_JWT_SECRET must be set for the e2e service")

from simulator.run import run_scenario  # noqa: E402

run_scenario(state_path=STATE_PATH)

import uvicorn  # noqa: E402

from app.main import app  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
