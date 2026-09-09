# Requirement IDs: RES-07, RES-AC-04, GOV-RES-02, XCUT-08
"""Hardcoded in-memory mirror of src/resilience/defaults.json (DP-A §4.2).

Used verbatim when defaults.json is missing/unreadable/corrupt so config
resolution never throws and never blocks startup (DP-A §7.4, RES-RES-03).
Keep this file semantically identical to defaults.json.

Domain-free by construction (GOV-REU-02). Standard-library only (RES-REU-01).
"""

from __future__ import annotations

import copy
from typing import Any, Dict

FALLBACK_DEFAULTS: Dict[str, Any] = {
    "timeout_ms": 15000,
    "retries": 2,
    "backoff": {
        "policy": "exponential",
        "base_ms": 250,
        "factor": 2.0,
        "max_ms": 5000,
        "jitter": True,
    },
    "fallback_chain": {
        "order": ["cache", "replay", "none"],
        "secondary_provider": {"enabled": False},
        "cache": {"enabled": True},
        "replay": {"enabled": True},
        "none": {"enabled": True},
    },
    "cache_key_strategy": "auto",
    # Not present in defaults.json by design (schema defines no default; only
    # meaningful when cache_key_strategy=="explicit"). Empty string = unset.
    "cache_key_explicit": "",
    "forced_degraded": False,
}


def get_fallback_defaults() -> Dict[str, Any]:
    """Return a fresh deep copy of the hardcoded defaults (mutation-safe)."""
    return copy.deepcopy(FALLBACK_DEFAULTS)
