"""CLI: python -m simulator <reset|seed|inject|run|status|verify>."""

from __future__ import annotations

import argparse
import json
import sys

from simulator.run import (
    inject_state,
    reset_state,
    run_scenario,
    seed_state,
    status,
    verify,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m simulator",
        description="Deterministic synthetic SentinelZero hospital exercise (EXERCISE ONLY).",
    )
    parser.add_argument(
        "--state",
        default=None,
        help="State file path (default: simulator/.state/state.json).",
    )
    parser.add_argument(
        "--scenario",
        default=None,
        help="Scenario name or path (default: hospital_ransomware.json).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("reset", help="Write the clean baseline state.")
    sub.add_parser("seed", help="Alias for reset (baseline fixtures).")
    sub.add_parser("inject", help="Apply the synthetic ransomware injection (idempotent).")
    sub.add_parser("run", help="Write the fully injected demo-ready state.")
    sub.add_parser("status", help="Show phase, counts, labels, and integrity hash.")
    sub.add_parser("verify", help="Verify counts, uncertainty, hashes, and EXERCISE labels.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    commands = {
        "reset": lambda: reset_state(state_path=args.state, scenario=args.scenario),
        "seed": lambda: seed_state(state_path=args.state, scenario=args.scenario),
        "inject": lambda: inject_state(state_path=args.state, scenario=args.scenario),
        "run": lambda: run_scenario(state_path=args.state, scenario=args.scenario),
        "status": lambda: status(state_path=args.state),
        "verify": lambda: verify(state_path=args.state),
    }
    try:
        result = commands[args.command]()
    except FileNotFoundError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 2
    except Exception as exc:  # safe CLI failure without a traceback
        print(json.dumps({"ok": False, "error": type(exc).__name__}), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result.get("ok", True):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
