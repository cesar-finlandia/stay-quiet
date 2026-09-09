# Requirement IDs: RES-05, XCUT-08
"""Public entry point of the golden-path cache subpackage (DP-A §9.2).

Re-exports the GoldenCache factory + key-derivation helpers; internals stay
behind this barrel.
"""

from .store import (
    INDEX_VERSION,
    REPLAY_PREFIX,
    GoldenCache,
    create_golden_cache,
    derive_key_standalone,
    set_cache_warn_logger,
    stable_json_stringify,
)

__all__ = [
    "INDEX_VERSION",
    "REPLAY_PREFIX",
    "GoldenCache",
    "create_golden_cache",
    "derive_key_standalone",
    "set_cache_warn_logger",
    "stable_json_stringify",
]
