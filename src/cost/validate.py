# Requirement IDs: COST-02, GOV-RES-02
"""Local minimal validation of CostBudgetConfig — DP-I §4.3, §7 (malformed-config row).

Used standalone; when src.resilience exposes a compatible validator at runtime
it is delegated to as well — resolved lazily via importlib at call time so the
package's STATIC import graph carries zero chassis dependencies (COST-REU-01,
DP-I §8.1 CI grep) while §8.2 delegate-when-present behavior is preserved.
validate_cost_budget NEVER raises: any input shape yields (ok, errors)
(GOV-RES-02 / COST-RES-01). Provider-agnostic — no provider branches beyond
key lowercasing rules stated here (COST-REU-02).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List, Optional, Tuple

def _res04_validate():
    """RES-04 validator, resolved lazily at call time. A dynamic lookup keeps
    the static import graph sibling-free (COST-REU-01 / DP-I §8.1 CI grep)
    while still delegating when the resilience package is present (§8.2).
    Absence or any fault → None (local guard remains authoritative)."""
    try:
        import importlib

        module = importlib.import_module("src.resilience.validate")
        return getattr(module, "validate", None)
    except Exception:  # noqa: BLE001 — absence/failure is fine
        return None


def _load_contract_schema() -> Optional[dict]:
    """Load the frozen contract schema; unreadable → None (local guard only)."""
    p = Path(__file__).resolve().parents[2] / "contracts" / "cost-budget.schema.json"
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:  # noqa: BLE001
        return None

VALID_UNITS = ("tokens", "requests", "estimated_cost")

_SCOPE_KEYS = ("budget", "unit", "threshold", "critical_threshold", "label")
_TOP_KEYS = ("global", "per_provider")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_scope(path: str, scope: Any, errors: List[str], critical_ok: bool = True) -> None:
    """Field-level checks for one BudgetScope at JSON path `path`. Appends errors."""
    if not isinstance(scope, dict):
        errors.append(f"{path} must be an object")
        return
    for key in scope:
        if key not in _SCOPE_KEYS:
            errors.append(f"{path}.{key} is not a known field")
    budget = scope.get("budget")
    if budget is None:
        errors.append(f"{path}.budget is required")
    elif not _is_number(budget) or budget <= 0:
        errors.append(f"{path}.budget must be a positive number (got {budget!r})")
    unit = scope.get("unit")
    if unit is not None and unit not in VALID_UNITS:
        errors.append(f"{path}.unit must be one of {list(VALID_UNITS)} (got {unit!r})")
    threshold = scope.get("threshold")
    if threshold is not None and (not _is_number(threshold) or not 0.0 <= threshold <= 1.0):
        errors.append(f"{path}.threshold must be a number in 0..1 (got {threshold!r})")
    critical = scope.get("critical_threshold")
    if critical is not None:
        if not _is_number(critical) or not 0.0 <= critical <= 1.0:
            errors.append(f"{path}.critical_threshold must be a number/null in 0..1 (got {critical!r})")
        elif critical_ok and _is_number(threshold) and 0.0 <= threshold <= 1.0 and critical <= threshold:
            # DP-I §6.1: critical_threshold must be > threshold — validation enforces.
            errors.append(f"{path}.critical_threshold must be > threshold ({critical!r} <= {threshold!r})")
    label = scope.get("label")
    if label is not None and not isinstance(label, str):
        errors.append(f"{path}.label must be a string (got {label!r})")


def _local_validate(cfg: Any, errors: List[str]) -> None:
    """Structural checks mirroring contracts/cost-budget.schema.json."""
    if not isinstance(cfg, dict):
        errors.append("config root must be an object")
        return
    for key in cfg:
        if key not in _TOP_KEYS:
            errors.append(f"{key} is not a known field")
    if "global" in cfg:
        _validate_scope("global", cfg["global"], errors)
    per_provider = cfg.get("per_provider")
    if per_provider is not None:
        if not isinstance(per_provider, dict):
            errors.append("per_provider must be an object keyed by lowercased provider")
        else:
            for provider, scope in per_provider.items():
                key = provider if isinstance(provider, str) else str(provider)
                if key != key.lower() or not key:
                    errors.append(f"per_provider.{provider} key must be a non-empty lowercase string")
                _validate_scope(f"per_provider.{key}", scope, errors)


def validate_cost_budget(cfg: Any) -> Tuple[bool, List[str]]:
    """Validate a CostBudgetConfig; returns (ok, errors). Never raises.

    Runs the local structural guard always; when the resilience package
    exposes the RES-04 validator AND contracts/cost-budget.schema.json is
    readable, schema errors are merged in (deduplicated by message).
    """
    try:
        errors: List[str] = []
        _local_validate(cfg, errors)
        res04 = _res04_validate()
        if res04 is not None:
            try:
                schema = _load_contract_schema() if _load_contract_schema is not None else None
                if schema is not None:
                    result = res04(schema, cfg)
                    seen = set(errors)
                    for e in result.get("errors", []):
                        msg = f"{e.get('path', '/')} {e.get('message', '')}".strip()
                        if msg not in seen:
                            seen.add(msg)
                            errors.append(msg)
            except Exception:  # noqa: BLE001 — delegation failure must not raise
                pass
        return (len(errors) == 0, errors)
    except Exception as err:  # noqa: BLE001 — GOV-RES-02: never propagate
        return (False, [f"validation internal error: {err}"])

# --- extended below: nothing (validate.py complete) ---
