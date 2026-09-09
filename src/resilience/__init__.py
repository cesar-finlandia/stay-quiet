# Requirement IDs: RES-REU-01, RES-04, RES-01, RES-05, RES-06, XCUT-06, XCUT-08
"""The ONLY curated public surface of the resilience layer (DP-A §9.1/§9.4).

Consumers import exclusively from ``src.resilience`` — never from internal
modules (``cache.store``, ``config``, wrapper internals). Deep imports are
CI-blocked. Everything not listed here is an implementation detail.

Functions: with_resilience, with_validation, is_degraded_result,
           create_golden_cache, validate, repair
Types:     DegradedResult, ResilienceConfig, GoldenCache, ValidationError
"""

from .wrapper import with_resilience, with_validation

from .degraded import DegradedResult, is_degraded_result

from .config import ResilienceConfig

from .cache import GoldenCache, create_golden_cache

from .validate import ValidationError, render_repair_prompt, repair, validate

__all__ = [
    "DegradedResult",
    "GoldenCache",
    "ResilienceConfig",
    "ValidationError",
    "create_golden_cache",
    "is_degraded_result",
    "render_repair_prompt",
    "repair",
    "validate",
    "with_resilience",
    "with_validation",
]
