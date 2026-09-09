# Requirement IDs: RES-06, UI-RES-02, DEP-RES-01, XCUT-08
"""DegradedResult typed signal — DP-A §4.3.

Python mirror of degraded.ts. Single source of truth is the frozen contract
contracts/degraded-result.schema.json. Consumers detect degraded mode via the
single discriminator check ``result["degraded"] is True`` (UI-RES-02).
Domain-free (GOV-REU-02); standard library only (RES-REU-01).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional, TypedDict

DEGRADED_RESULT_VERSION = "1.0.0"

FallbackSource = Literal["secondary_provider", "cache", "replay", "none"]


class DegradedResult(TypedDict):
    """Frozen contract contracts/degraded-result.schema.json (DP-A §4.3)."""

    degraded: Literal[True]  # discriminator — UI-RES-02 checks this field
    reason: str
    fallback_source: FallbackSource
    original_error: Optional[str]
    data: Optional[Any]
    timestamp: str  # ISO-8601
    version: Literal["1.0.0"]


def make_degraded_result(
    reason: str,
    fallback_source: FallbackSource,
    original_error: Optional[str] = None,
    data: Optional[Any] = None,
) -> DegradedResult:
    """Factory: fills timestamp (ISO-8601 UTC) and version per the frozen contract."""
    return {
        "degraded": True,
        "reason": reason,
        "fallback_source": fallback_source,
        "original_error": original_error,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": DEGRADED_RESULT_VERSION,
    }


def is_degraded_result(value: Any) -> bool:
    """Type guard per UI-RES-02: single discriminator `degraded is True` plus
    minimal shape check. Never throws."""
    return (
        isinstance(value, dict)
        and value.get("degraded") is True
        and isinstance(value.get("reason"), str)
        and isinstance(value.get("fallback_source"), str)
        and isinstance(value.get("timestamp"), str)
    )
