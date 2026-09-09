# Requirement IDs: COST-04
"""`cost-summary` — read-only CLI for the Cost & Usage Guardrail (DP-I §8.5).

Renders the human-readable usage table (`CostStore.render_summary`, DP-I §4.5)
or, with `--json`, emits the machine-readable `CostStoreSnapshot`
(`contracts/cost-store-snapshot.schema.json`) for BENCH/TRACK consumption.

Packaging note: installed via `pyproject.toml` `[project.scripts]` as
`cost-summary = "src.cost.cli:main"`; equivalent to
`python3 -m src.cost.cli`.

Read-only guarantee: never mutates accumulation state beyond an explicit
`--persist <path>` snapshot write; no RES-* calls; no config writes.
Exit code is 0 ALWAYS — any internal error prints the minimal fallback line
instead of raising (GOV-RES-04). Stdlib only (argparse/json).
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .config import load_budget_defaults, resolve_effective_config
from .store import CostStore
from .types import CostBudgetConfig
from .validate import validate_cost_budget

__all__ = ["main", "build_parser"]


def build_parser() -> argparse.ArgumentParser:
    """Flag-only parser per DP-I §8.5."""
    p = argparse.ArgumentParser(
        prog="cost-summary",
        description="Render the local cost/usage summary table (COST-04) — "
        "read-only estimate, not billing (NONGOAL-11).",
    )
    p.add_argument(
        "--store",
        metavar="PATH",
        default=None,
        help="load a persisted CostStoreSnapshot JSON before rendering "
        "(corrupt file → warn and start fresh, GOV-RES-02)",
    )
    p.add_argument(
        "--budget",
        metavar="PATH",
        default=None,
        help="explicit CostBudgetConfig JSON (e.g. config/cost.json) used "
        "for utilization math; invalid config → safe defaults",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable CostStoreSnapshot JSON instead of the table",
    )
    p.add_argument(
        "--persist",
        metavar="PATH",
        default=None,
        help="write the (post-load) snapshot to PATH after rendering input",
    )
    return p


_FALLBACK_LINE = (
    "+-------------------------------------------------------------------------+\n"
    "| COST — Usage Summary unavailable (internal error)                       |\n"
    "+-------------------------------------------------------------------------+"
)


def _warn(msg: str) -> None:
    print(f"[COST] {msg}", file=sys.stderr)


def _load_snapshot_file(store: CostStore, path: str) -> None:
    """Read a persisted snapshot and hand it to load_snapshot.

    Unreadable/malformed file → warn and start fresh (GOV-RES-02); deeper
    corruption is handled inside load_snapshot itself.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            snap = json.load(fh)
    except Exception as exc:  # noqa: BLE001 — read-only CLI never fails
        _warn(f"cost-summary: store snapshot unreadable at {path!r} — starting fresh ({exc})")
        return
    store.load_snapshot(snap)  # corrupt → warn + discard inside


def _load_explicit_budget(path: str) -> CostBudgetConfig:
    """Load an explicit --budget file, validated via validate.py.

    Invalid/unreadable config → warn once and fall back to the safe defaults
    (never the raw file contents).
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        _warn(f"cost-summary: budget config unreadable at {path!r} — using safe defaults ({exc})")
        return load_budget_defaults()
    ok, errors = validate_cost_budget(raw)
    if not ok:
        for err in errors:
            _warn(f"budget config invalid ({err})")
        _warn("cost-summary: budget config invalid — using safe defaults")
        return load_budget_defaults()
    return raw  # sanitized downstream by render_summary/check_budget


def _force_utf8_stdio() -> None:
    """Render the summary table on consoles whose default encoding is not UTF-8.

    ``render_summary`` draws the table with box-drawing characters and an em-dash. On
    Windows the default stdout encoding is the ANSI code page (cp1252), so printing it
    raised UnicodeEncodeError, the blanket handler in ``main`` swallowed it, and the CLI
    printed only the fallback line — which contains an em-dash of its own and came out
    mangled too. The table was therefore unreachable on a stock Windows console.

    ``errors="replace"`` keeps the never-raise contract even for a code page that cannot
    represent some glyph we add later.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001 — non-reconfigurable stream (pipe/StringIO): keep going
            pass


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point — exit code 0 ALWAYS (read-only, never fails; GOV-RES-04)."""
    args = build_parser().parse_args(argv)
    _force_utf8_stdio()
    try:
        store = CostStore()
        if args.store:
            _load_snapshot_file(store, args.store)
        budget_cfg: Optional[CostBudgetConfig] = None
        if args.budget:
            budget_cfg = _load_explicit_budget(args.budget)
        if args.persist:
            store._persist(args.persist)  # noqa: SLF001 — same package; atomic §8.3 write
        if args.json:
            snap = store.to_json()
            if budget_cfg is not None:
                snap["warnings"] = store.check_budget(budget_cfg)  # computed warnings array
            print(json.dumps(snap))
        else:
            print(store.render_summary(budget_cfg))
    except Exception as exc:  # noqa: BLE001 — minimal fallback, never raise
        _warn(f"cost-summary internal error ({exc})")
        print(_FALLBACK_LINE)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
