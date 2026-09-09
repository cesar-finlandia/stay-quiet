# Requirement IDs: RES-02, RES-03, RES-07, RES-AC-04, GOV-RES-02, RES-RES-03, XCUT-08
"""Configuration system for the resilience layer (DP-A Â§3.2, Â§4.2, Â§7).

Python mirror of config.ts. Precedence (lowest â†’ highest):
defaults.json â†’ per-call ResilienceConfig (shallow merge, per-call wins) â†’ env
vars RES_FORCED_DEGRADED=1 / RES_TIMEOUT_MS / RES_RETRIES.

Never throws: malformed fields warn + substitute defaults (Â§7.4); corrupt or
missing defaults.json falls back to hardcoded FALLBACK_DEFAULTS (defaults.py).
Domain-free (GOV-REU-02); standard library only (RES-REU-01).
"""

from __future__ import annotations

import copy
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, TypedDict

from .defaults import get_fallback_defaults

_logger = logging.getLogger("resilience.config")

timeout_ms_default = 15000
retries_default = 2
TIMEOUT_MIN, TIMEOUT_MAX = 100, 1800000
RETRIES_MIN, RETRIES_MAX = 0, 5
BACKOFF_POLICIES = ("exponential", "linear", "fixed", "none")
FALLBACK_STEPS = ("secondary_provider", "cache", "replay", "none")
CACHE_KEY_STRATEGIES = ("auto", "explicit")

BackoffPolicy = Literal["exponential", "linear", "fixed", "none"]
FallbackStep = Literal["secondary_provider", "cache", "replay", "none"]
CacheKeyStrategy = Literal["auto", "explicit"]


class Backoff(TypedDict, total=False):
    policy: BackoffPolicy
    base_ms: int
    factor: float
    max_ms: int
    jitter: bool


class FallbackStepConfig(TypedDict, total=False):
    enabled: bool


class FallbackChain(TypedDict, total=False):
    order: List[FallbackStep]
    secondary_provider: FallbackStepConfig
    cache: FallbackStepConfig
    replay: FallbackStepConfig
    none: FallbackStepConfig


class ResilienceConfig(TypedDict, total=False):
    """Per-call config shape â€” DP-A Â§4.2. All keys optional."""

    timeout_ms: int  # default 15000, min 100, max 1800000
    retries: int  # default 2, min 0, max 5
    backoff: Backoff
    fallback_chain: FallbackChain
    cache_key_strategy: CacheKeyStrategy  # default "auto"
    cache_key_explicit: str  # required iff strategy=="explicit"
    forced_degraded: bool  # default false â€” kill switch RES-07


class EffectiveConfig(ResilienceConfig, total=True):
    """Fully-resolved config: every key present."""


# ---------------------------------------------------------------- defaults

_DEFAULTS_PATH = Path(__file__).resolve().parent / "defaults.json"
_cached_globals: Optional[EffectiveConfig] = None


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _warn_invalid(path: str, value: Any, fallback: Any) -> Any:
    _logger.warning(
        "resilience config field %s invalid (%s), using default %s",
        path,
        json.dumps(value) if isinstance(value, (dict, list)) else repr(value),
        json.dumps(fallback) if isinstance(fallback, (dict, list)) else repr(fallback),
    )
    return copy.deepcopy(fallback)


def load_global_defaults() -> EffectiveConfig:
    """Load global defaults from defaults.json (read once, then cached).

    Missing/unreadable/corrupt file â†’ hardcoded FALLBACK_DEFAULTS (Â§7.4).
    """
    global _cached_globals
    if _cached_globals is not None:
        return _cached_globals
    try:
        with open(_DEFAULTS_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("defaults.json root is not an object")
        _cached_globals = normalize_config(raw, _fallback_lookup)
    except Exception as err:  # noqa: BLE001 â€” never propagate (RES-RES-03)
        _logger.warning(
            "resilience defaults.json unreadable or corrupt (%s), using hardcoded in-memory defaults",
            err,
        )
        _cached_globals = get_fallback_defaults()
    return _cached_globals


def _fallback_lookup(path: str) -> Any:
    cur: Any = get_fallback_defaults()
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


# ------------------------------------------------------- normalization

def normalize_config(raw: Dict[str, Any], fallback_for: Callable[[str], Any]) -> EffectiveConfig:
    """Normalize an arbitrary parsed config into a full EffectiveConfig.

    Missing fields â†’ fallback; malformed â†’ warn + fallback substitution;
    unknown keys â†’ warn + ignore. Mirrors contracts/resilience-config.schema.json
    structurally (step-4 RES-04 swaps in the shared validator; behavior identical).
    """
    out: Dict[str, Any] = {}

    for key in raw:
        if key not in get_fallback_defaults():
            _logger.warning("resilience config field %s unknown, ignoring", key)

    # timeout_ms: integer [100, 1800000]
    t = raw.get("timeout_ms")
    fb_t = fallback_for("timeout_ms")
    if t is None:
        out["timeout_ms"] = fb_t
    elif _is_int(t) and TIMEOUT_MIN <= t <= TIMEOUT_MAX:
        out["timeout_ms"] = t
    else:
        out["timeout_ms"] = _warn_invalid("timeout_ms", t, fb_t)

    # retries: integer [0, 5]
    r = raw.get("retries")
    fb_r = fallback_for("retries")
    if r is None:
        out["retries"] = fb_r
    elif _is_int(r) and RETRIES_MIN <= r <= RETRIES_MAX:
        out["retries"] = r
    else:
        out["retries"] = _warn_invalid("retries", r, fb_r)

    # backoff
    fb_backoff = fallback_for("backoff") or {}
    raw_backoff = raw.get("backoff")
    if raw_backoff is None:
        out["backoff"] = copy.deepcopy(fb_backoff)
    elif not isinstance(raw_backoff, dict):
        out["backoff"] = _warn_invalid("backoff", raw_backoff, copy.deepcopy(fb_backoff))
    else:
        for k in raw_backoff:
            if k not in fb_backoff:
                _logger.warning("resilience config field backoff.%s unknown, ignoring", k)
        policy = raw_backoff.get("policy")
        out["backoff"] = {
            "policy": (
                fb_backoff.get("policy")
                if policy is None
                else policy if policy in BACKOFF_POLICIES
                else _warn_invalid("backoff.policy", policy, fb_backoff.get("policy"))
            ),
            "base_ms": (
                fb_backoff.get("base_ms")
                if raw_backoff.get("base_ms") is None
                else raw_backoff["base_ms"] if _is_int(raw_backoff["base_ms"]) and raw_backoff["base_ms"] >= 10
                else _warn_invalid("backoff.base_ms", raw_backoff.get("base_ms"), fb_backoff.get("base_ms"))
            ),
            "factor": (
                fb_backoff.get("factor")
                if raw_backoff.get("factor") is None
                else raw_backoff["factor"]
                if isinstance(raw_backoff["factor"], (int, float)) and not isinstance(raw_backoff["factor"], bool) and raw_backoff["factor"] >= 1.0
                else _warn_invalid("backoff.factor", raw_backoff.get("factor"), fb_backoff.get("factor"))
            ),
            "max_ms": (
                fb_backoff.get("max_ms")
                if raw_backoff.get("max_ms") is None
                else raw_backoff["max_ms"] if _is_int(raw_backoff["max_ms"])
                else _warn_invalid("backoff.max_ms", raw_backoff.get("max_ms"), fb_backoff.get("max_ms"))
            ),
            "jitter": (
                fb_backoff.get("jitter")
                if raw_backoff.get("jitter") is None
                else raw_backoff["jitter"] if isinstance(raw_backoff["jitter"], bool)
                else _warn_invalid("backoff.jitter", raw_backoff.get("jitter"), fb_backoff.get("jitter"))
            ),
        }

    # fallback_chain
    fb_chain = copy.deepcopy(fallback_for("fallback_chain") or {})
    raw_chain = raw.get("fallback_chain")
    if raw_chain is None:
        out["fallback_chain"] = fb_chain
    elif not isinstance(raw_chain, dict):
        out["fallback_chain"] = _warn_invalid("fallback_chain", raw_chain, fb_chain)
    else:
        for k in raw_chain:
            if k not in fb_chain:
                _logger.warning("resilience config field fallback_chain.%s unknown, ignoring", k)
        raw_order = raw_chain.get("order")
        valid_order = isinstance(raw_order, list) and all(s in FALLBACK_STEPS for s in raw_order)
        steps: Dict[str, Dict[str, bool]] = {}
        for name in ("secondary_provider", "cache", "replay", "none"):
            fb_enabled = bool(fb_chain.get(name, {}).get("enabled"))
            raw_step = raw_chain.get(name)
            if name == "none":
                # terminal step is always enabled â€” schema pins enabled to true
                steps[name] = {"enabled": True}
            elif raw_step is None:
                steps[name] = {"enabled": fb_enabled}
            elif not isinstance(raw_step, dict) or any(k2 not in fb_chain.get(name, {}) for k2 in raw_step) or (
                "enabled" in raw_step and not isinstance(raw_step["enabled"], bool)
            ):
                steps[name] = _warn_invalid(f"fallback_chain.{name}", raw_step, {"enabled": fb_enabled})
            else:
                steps[name] = {"enabled": fb_enabled if raw_step.get("enabled") is None else raw_step["enabled"]}
        out["fallback_chain"] = {
            "order": fb_chain.get("order") if raw_order is None else raw_order if valid_order else _warn_invalid("fallback_chain.order", raw_order, fb_chain.get("order")),
            **steps,
        }

    # cache_key_strategy (+ conditional cache_key_explicit per schema allOf)
    fb_strategy = fallback_for("cache_key_strategy")
    strategy = raw.get("cache_key_strategy")
    eff_strategy = (
        fb_strategy
        if strategy is None
        else strategy if strategy in CACHE_KEY_STRATEGIES
        else _warn_invalid("cache_key_strategy", strategy, fb_strategy)
    )
    raw_explicit = raw.get("cache_key_explicit")
    if raw_explicit is None:
        eff_explicit = fallback_for("cache_key_explicit") or ""
    elif not isinstance(raw_explicit, str):
        eff_explicit = _warn_invalid("cache_key_explicit", raw_explicit, "")
    else:
        # empty string is legal (= unset); explicit-strategy precondition checked below
        eff_explicit = raw_explicit
    if eff_strategy == "explicit" and not eff_explicit:
        # strategy precondition broken â†’ warn and fall back to "auto"
        _logger.warning(
            'resilience config field cache_key_strategy invalid (explicit without usable cache_key_explicit), using default auto'
        )
        eff_strategy = "auto"
    out["cache_key_strategy"] = eff_strategy
    out["cache_key_explicit"] = eff_explicit

    # forced_degraded
    fd = raw.get("forced_degraded")
    fb_fd = fallback_for("forced_degraded")
    if fd is None:
        out["forced_degraded"] = fb_fd
    elif isinstance(fd, bool):
        out["forced_degraded"] = fd
    else:
        out["forced_degraded"] = _warn_invalid("forced_degraded", fd, fb_fd)

    return out


# ------------------------------------------------------- env + resolution

def _apply_env_overrides(effective: Dict[str, Any], env: Dict[str, str]) -> None:
    """Apply operator env vars over a normalized config (env wins, Â§7.1).

    RES_FORCED_DEGRADED=1, RES_TIMEOUT_MS, RES_RETRIES.
    Invalid values warn + are ignored â€” never throw (Â§7.4).
    """
    forced = env.get("RES_FORCED_DEGRADED")
    if forced:
        if forced == "1":
            effective["forced_degraded"] = True
        else:
            _logger.warning(
                "resilience config field RES_FORCED_DEGRADED invalid (%r), using default %r; expected \"1\"",
                forced,
                effective["forced_degraded"],
            )

    timeout = env.get("RES_TIMEOUT_MS")
    if timeout:
        try:
            parsed = int(timeout)
        except ValueError:
            parsed = None
        if parsed is not None and TIMEOUT_MIN <= parsed <= TIMEOUT_MAX:
            effective["timeout_ms"] = parsed
        else:
            _logger.warning(
                "resilience config field RES_TIMEOUT_MS invalid (%s), using default %s",
                timeout,
                effective["timeout_ms"],
            )

    retries = env.get("RES_RETRIES")
    if retries:
        try:
            parsed = int(retries)
        except ValueError:
            parsed = None
        if parsed is not None and RETRIES_MIN <= parsed <= RETRIES_MAX:
            effective["retries"] = parsed
        else:
            _logger.warning(
                "resilience config field RES_RETRIES invalid (%s), using default %s",
                retries,
                effective["retries"],
            )


def resolve_config(per_call: Optional[ResilienceConfig] = None,
                   env: Optional[Dict[str, str]] = None) -> EffectiveConfig:
    """Resolve a fully-validated EffectiveConfig from all three precedence tiers.

    defaults.json < per-call config (shallow merge, per-call wins) < env vars.
    Accepts None/{} â†’ all defaults (RES-AC-04). Never throws.
    """
    globals_ = load_global_defaults()

    if per_call is None or not isinstance(per_call, dict):
        if per_call is not None:
            _logger.warning(
                "resilience config field (per-call) invalid (%r), using global defaults", per_call
            )
        merged: Dict[str, Any] = copy.deepcopy(globals_)
    else:
        for key in per_call:
            if key not in get_fallback_defaults():
                _logger.warning("resilience config field %s unknown, ignoring", key)
        # shallow top-level merge: per-call wins wholesale per key
        merged = {**copy.deepcopy(globals_), **copy.deepcopy(dict(per_call))}

    effective = normalize_config(merged, _fallback_lookup)
    _apply_env_overrides(effective, os.environ if env is None else env)
    return effective


def create_config_resolver(per_call: Optional[ResilienceConfig] = None) -> Callable[[], EffectiveConfig]:
    """Resolve the config ONCE at wrapper creation; return an accessor that
    hands back the same cached EffectiveConfig on every hot-path call (Â§3.2)."""
    effective = resolve_config(per_call)
    return lambda: effective
