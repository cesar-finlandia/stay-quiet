# Requirement IDs: COST-02, GOV-RES-02
"""Budget config resolution, merging, and env overrides — DP-I §4.3, §6.3, §7.

Precedence (lowest → highest):
src/cost/defaults.json → config/cost.json (optional file) → store-level
CostBudgetConfig → per-wrapper CostMeteringOpts.budget_config (per-scope wins)
→ env vars (COST_GLOBAL_BUDGET, COST_GLOBAL_THRESHOLD,
COST_PROVIDER_BUDGET_<PROVIDER>, COST_WARN_CALLBACK).

Never throws: malformed/missing config warns
`[COST] budget config field <path> invalid (<value>), using default` and
substitutes safe defaults exactly as the DP-I §7 table specifies — missing
global budget → 1000000; invalid threshold → 0.8; invalid unit → tokens;
missing entire config → defaults.json (GOV-RES-02 / COST-RES-01). Every public
function is outer try/except bounded (GOV-RES-04). Provider-agnostic beyond
lowercasing env-derived keys (COST-REU-02). Standard library only; the only
optional import is src.cost.validate (same package, safe by construction).
"""

from __future__ import annotations

import copy
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .types import BudgetScope, CostBudgetConfig

_logger = logging.getLogger("cost.config")

VALID_UNITS = ("tokens", "requests", "estimated_cost")

DEFAULT_GLOBAL_BUDGET = 1000000  # DP-I §7: missing global budget → 1000000
DEFAULT_THRESHOLD = 0.8  # DP-I §6.1 / §10 resolved decision 6.11
DEFAULT_UNIT = "tokens"  # DP-I §6.2

# Hardcoded mirror of defaults.json (corrupt/unreadable file fallback).
FALLBACK_DEFAULTS: CostBudgetConfig = {
    "global": {  # type: ignore[typeddict-item] — key "global" via functional TypedDict
        "budget": DEFAULT_GLOBAL_BUDGET,
        "unit": DEFAULT_UNIT,
        "threshold": DEFAULT_THRESHOLD,
        "label": "session-global",
    }
}

_DEFAULTS_PATH = Path(__file__).resolve().parent / "defaults.json"
_FILE_CONFIG_CANDIDATES = (
    Path.cwd() / "config" / "cost.json",  # <working-copy>/config/cost.json (DP-I §6.3)
)

_cached_defaults: Optional[CostBudgetConfig] = None
_cached_file_config: Optional[Dict[str, Any]] = None


def _warn_invalid(path: str, value: Any, default: Any) -> Any:
    """DP-I §7 exact warn line; returns the safe default to substitute."""
    try:
        rendered = json.dumps(value) if isinstance(value, (dict, list)) else repr(value)
    except Exception:  # noqa: BLE001 — repr fallback for unserializable values
        rendered = repr(value)
    _logger.warning("[COST] budget config field %s invalid (%s), using default", path, rendered)
    return copy.deepcopy(default)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def load_budget_defaults() -> CostBudgetConfig:
    """Load src/cost/defaults.json (read once, then cached).

    Missing/unreadable/corrupt file → hardcoded FALLBACK_DEFAULTS (DP-I §7
    missing-entire-config row). Never throws.
    """
    global _cached_defaults
    if _cached_defaults is not None:
        return _cached_defaults
    try:
        with open(_DEFAULTS_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("defaults.json root is not an object")
        _cached_defaults = raw  # trusted checked-in file; still sanitized on resolve
    except Exception as err:  # noqa: BLE001 — never propagate (GOV-RES-02)
        _logger.warning(
            "[COST] defaults.json unreadable or corrupt (%s), using in-memory fallback",
            err,
        )
        _cached_defaults = copy.deepcopy(FALLBACK_DEFAULTS)
    return _cached_defaults

# --- extended below: file config + merge + env + resolve ---


def load_file_config(path: Optional[os.PathLike] = None) -> CostBudgetConfig:
    """Load optional config/cost.json (DP-I §6.3 file vector). Never throws.

    Missing file → {} (resolve fills defaults). Malformed JSON or non-object →
    warn `[COST] budget config invalid (...), ignoring file` and return {}.
    Result cached; pass `path` explicitly (or set reload via clear caches) for
    tests.
    """
    global _cached_file_config
    try:
        if path is None and _cached_file_config is not None:
            return copy.deepcopy(_cached_file_config)
        candidates = [Path(path)] if path is not None else list(_FILE_CONFIG_CANDIDATES)
        cfg_path = next((c for c in candidates if c.is_file()), None)
        if cfg_path is None:
            loaded: CostBudgetConfig = {}
        else:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
            if not isinstance(raw, dict):
                raise ValueError("cost.json root is not an object")
            ok, errors = _validate_shape(raw)
            if not ok:
                for e in errors:
                    _logger.warning("[COST] budget config %s — ignoring field", e)
                # fall through: sanitize drops invalid fields below
            loaded = raw
        if path is None:
            _cached_file_config = copy.deepcopy(loaded)
        return copy.deepcopy(loaded)
    except Exception as err:  # noqa: BLE001 — malformed file never crashes startup
        _logger.warning("[COST] budget config file unreadable (%s), ignoring file", err)
        return {}


def _validate_shape(cfg: Any) -> Tuple[bool, list]:
    """Shape-check against the contract — delegates to .validate (RES-04 else local)."""
    from .validate import validate_cost_budget

    return validate_cost_budget(cfg)


def _sanitize_scope(path: str, scope: Any) -> Optional[BudgetScope]:
    """Coerce one BudgetScope to safe values; returns None only when unusable
    (per-provider scope without valid budget → dropped, DP-I §7 'Budget: —').
    Warns per invalid field with the §7 message format."""
    if not isinstance(scope, dict):
        return None  # caller warns at the config level
    out: BudgetScope = {}
    budget = scope.get("budget")
    if not _is_number(budget) or budget <= 0:
        default_budget = DEFAULT_GLOBAL_BUDGET if path == "global" else None
        if default_budget is None:
            _warn_invalid(f"{path}.budget", budget, "— (scope dropped)")
            return None
        out["budget"] = _warn_invalid(f"{path}.budget", budget, default_budget)
    else:
        out["budget"] = budget
    unit = scope.get("unit")
    if unit is None:
        out["unit"] = DEFAULT_UNIT
    elif unit not in VALID_UNITS:
        out["unit"] = _warn_invalid(f"{path}.unit", unit, DEFAULT_UNIT)
    else:
        out["unit"] = unit
    threshold = scope.get("threshold")
    if threshold is None:
        out["threshold"] = DEFAULT_THRESHOLD
    elif not _is_number(threshold) or not 0.0 <= threshold <= 1.0:
        out["threshold"] = _warn_invalid(f"{path}.threshold", threshold, DEFAULT_THRESHOLD)
    else:
        out["threshold"] = threshold
    critical = scope.get("critical_threshold")
    if critical is not None:
        if not _is_number(critical) or not 0.0 <= critical <= 1.0:
            out.pop("critical_threshold", None)
            _warn_invalid(f"{path}.critical_threshold", critical, "null (omitted)")
        elif critical <= out["threshold"]:
            out.pop("critical_threshold", None)
            _logger.warning(
                "[COST] budget config field %s.critical_threshold (%s) must be > threshold, omitting",
                path,
                critical,
            )
        else:
            out["critical_threshold"] = critical
    label = scope.get("label")
    if isinstance(label, str) and label:
        out["label"] = label
    return out

# --- extended below: merge + env + resolve ---


def sanitize_budget_config(cfg: Any) -> CostBudgetConfig:
    """Coerce any parsed config into a safe CostBudgetConfig. Never throws.

    Invalid scopes/fields are warned about (§7 message) and replaced or dropped;
    missing entire config → defaults.json shape.
    """
    try:
        if not isinstance(cfg, dict):
            if cfg is not None:
                _warn_invalid("config", cfg, "defaults")
            return copy.deepcopy(load_budget_defaults())
        out: CostBudgetConfig = {}
        if "global" in cfg:
            g = _sanitize_scope("global", cfg.get("global"))
            if g is not None:
                out["global"] = g
        pp = cfg.get("per_provider")
        if isinstance(pp, dict):
            clean_pp: Dict[str, BudgetScope] = {}
            for provider, scope in pp.items():
                key = provider.lower() if isinstance(provider, str) else str(provider)
                if not key or key != provider:
                    _warn_invalid(f"per_provider.{provider}", provider, "lowercased key")
                s = _sanitize_scope(f"per_provider.{key}", scope)
                if s is not None:
                    clean_pp[key] = s
            if clean_pp:
                out["per_provider"] = clean_pp
        return out
    except Exception as err:  # noqa: BLE001 — GOV-RES-04 outer bound
        _logger.warning("[COST] internal error sanitizing budget config (%s), using defaults", err)
        return copy.deepcopy(load_budget_defaults())


def _raw_merge(base: Any, overlay: Any) -> Dict[str, Any]:
    """Raw per-scope-wins merge of two unparsed configs (DP-I §6.3).

    Field-level within each scope: overlay fields beat base fields; fields the
    overlay omits inherit base values. No validation/back-fill here — callers
    sanitize AFTER all layers are merged so defaulted fields never leak
    downward and clobber explicit lower-layer values.
    """
    out: Dict[str, Any] = copy.deepcopy(base) if isinstance(base, dict) else {}
    if not isinstance(overlay, dict):
        return out
    og = overlay.get("global")
    if isinstance(og, dict):
        g = dict(out.get("global") or {})
        g.update(copy.deepcopy(og))
        out["global"] = g
    opp = overlay.get("per_provider")
    if isinstance(opp, dict):
        pp = dict(out.get("per_provider") or {})
        for provider, scope in opp.items():
            key = provider.lower() if isinstance(provider, str) else str(provider)
            existing = pp.get(key)
            if isinstance(scope, dict):
                merged_scope = dict(existing) if isinstance(existing, dict) else {}
                merged_scope.update(copy.deepcopy(scope))
                pp[key] = merged_scope
            else:
                pp[key] = scope  # non-dict scope kept raw; sanitize warns/drops later
        out["per_provider"] = pp
    return out


def merge_budget_config(store_cfg: Optional[CostBudgetConfig], wrapper_cfg: Optional[CostBudgetConfig]) -> CostBudgetConfig:
    """Per-scope-wins merge (DP-I §6.3): wrapper fields override store fields
    within the same scope; unspecified fields inherit store-level values.
    Returns a sanitized safe config. Never throws."""
    try:
        merged = _raw_merge(store_cfg, wrapper_cfg)
        if not merged:
            return {}
        return sanitize_budget_config(merged)
    except Exception as err:  # noqa: BLE001 — GOV-RES-04 outer bound
        _logger.warning("[COST] internal error merging budget config (%s), using defaults", err)
        return copy.deepcopy(load_budget_defaults())

# --- extended below: env + resolve ---


def _parse_env_number(raw: Any, path: str) -> Optional[float]:
    """Numeric env string → float; invalid → warn + None (ignored)."""
    try:
        value = float(str(raw).strip())  # numeric string per §6.3
        return value
    except (TypeError, ValueError):
        _warn_invalid(path, raw, "(env var ignored)")
        return None


def apply_env_overrides(cfg: CostBudgetConfig, environ: Optional[Dict[str, str]] = None) -> CostBudgetConfig:
    """Apply env overrides with highest precedence (DP-I §6.3). Never throws.

    COST_GLOBAL_BUDGET / COST_GLOBAL_THRESHOLD / COST_PROVIDER_BUDGET_<P>.
    Invalid values warn and are ignored — config stays safe. Provider keys are
    lowercased; that is the only provider-specific behavior (COST-REU-02).
    """
    try:
        env = os.environ if environ is None else environ
        out = copy.deepcopy(cfg)
        raw_budget = env.get("COST_GLOBAL_BUDGET")
        if raw_budget is not None:
            value = _parse_env_number(raw_budget, "COST_GLOBAL_BUDGET")
            if value is not None and value > 0:
                g = dict(out.get("global") or {})
                g["budget"] = value
                out["global"] = g  # type: ignore[typeddict-item]
            elif value is not None:
                _warn_invalid("COST_GLOBAL_BUDGET", raw_budget, "(env var ignored)")
        raw_threshold = env.get("COST_GLOBAL_THRESHOLD")
        if raw_threshold is not None:
            value = _parse_env_number(raw_threshold, "COST_GLOBAL_THRESHOLD")
            if value is not None and 0.0 <= value <= 1.0:
                g = dict(out.get("global") or {})
                g["threshold"] = value
                out["global"] = g  # type: ignore[typeddict-item]
            elif value is not None:
                _warn_invalid("COST_GLOBAL_THRESHOLD", raw_threshold, "(env var ignored)")
        for key, raw in env.items():
            if not isinstance(key, str) or not key.startswith("COST_PROVIDER_BUDGET_"):
                continue
            provider = key[len("COST_PROVIDER_BUDGET_") :].strip().lower()
            if not provider:
                continue
            value = _parse_env_number(raw, key)
            if value is None or value <= 0:
                _warn_invalid(key, raw, "(env var ignored)")
                continue
            pp = dict(out.get("per_provider") or {})
            scope = dict(pp.get(provider) or {})
            scope["budget"] = value
            pp[provider] = scope  # type: ignore[index]
            out["per_provider"] = pp
        return out
    except Exception as err:  # noqa: BLE001 — GOV-RES-04 outer bound
        _logger.warning("[COST] internal error applying env overrides (%s), ignoring", err)
        return copy.deepcopy(cfg)


def warn_callback_enabled(environ: Optional[Dict[str, str]] = None) -> bool:
    """True iff COST_WARN_CALLBACK=1 — route warnings to console.warn (§6.3).
    Never throws."""
    try:
        env = os.environ if environ is None else environ
        return env.get("COST_WARN_CALLBACK") == "1"
    except Exception:  # noqa: BLE001 — GOV-RES-04 outer bound
        return False


def resolve_effective_config(
    store_cfg: Optional[CostBudgetConfig] = None,
    wrapper_cfg: Optional[CostBudgetConfig] = None,
    include_file_config: bool = True,
) -> CostBudgetConfig:
    """Full resolution chain (lowest → highest precedence): defaults.json →
    config/cost.json → store config → wrapper config (per-scope wins) → env
    overrides. Returns the effective config; global scope fully populated;
    per-provider scopes inherit unit/threshold fallbacks at warning-check time
    via DP-I §6.3 (`per_provider[p]?.threshold ?? global?.threshold ?? 0.8`).
    Never throws.
    """
    try:
        chain: Dict[str, Any] = {}
        for layer in (
            load_budget_defaults(),
            load_file_config() if include_file_config else {},
            store_cfg,
            wrapper_cfg,
        ):
            chain = _raw_merge(chain, layer)  # raw layers; sanitize once below
        effective = apply_env_overrides(sanitize_budget_config(chain))
        # Guarantee a usable global scope even if every layer omitted it.
        if not isinstance(effective.get("global"), dict):
            effective = sanitize_budget_config(_raw_merge(load_budget_defaults(), chain))
        return effective
    except Exception as err:  # noqa: BLE001 — GOV-RES-04 outer bound
        _logger.warning("[COST] internal error resolving budget config (%s), using defaults", err)
        return copy.deepcopy(load_budget_defaults())
