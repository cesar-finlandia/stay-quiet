# Requirement IDs: RES-01, RES-02, RES-03, RES-07, RES-AC-01, RES-AC-03, RES-AC-04, RES-RES-03, XCUT-08
"""Behavioral verification for src/resilience/wrapper.py (DP-A §10 mirrors).

Run: python -c "import sys; sys.path.insert(0,'src')" style harness or:
    python src/resilience/scripts/verify_wrapper.py   (adds repo root itself)
Exits 0 when every check passes; prints PASS/FAIL lines otherwise.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "src"))

from resilience.cache import GoldenCache, REPLAY_PREFIX  # noqa: E402
from resilience.degraded import is_degraded_result  # noqa: E402
from resilience.validate import ValidationRepairFailed  # noqa: E402
from resilience.wrapper import (  # noqa: E402
    WrapperDeps,
    compute_backoff_delay_ms,
    resilient,
    with_resilience,
)

RESULTS: list[tuple[bool, str]] = []


def check(name: str, cond: bool) -> None:
    RESULTS.append((bool(cond), name))
    print(("PASS" if cond else "FAIL") + f" - {name}")


def make_cache() -> tuple[GoldenCache, str]:
    tmp = tempfile.mkdtemp(prefix="golden-verify-")
    return GoldenCache(tmp), tmp


# ---------------------------------------------------------------- check 1-2

def test_cache_hit_path() -> None:
    """RES-AC-01 mirror: primary fails -> cache step returns the golden value."""
    cache, _ = make_cache()
    key = cache.derive_key("acme", "widget-v1", {"q": "hello"})
    cache.put(key, {"text": "golden hello"})
    calls = {"n": 0}

    def flaky() -> dict:
        calls["n"] += 1
        raise RuntimeError("401 invalid credentials")

    wrapped = with_resilience(
        flaky,
        {"timeout_ms": 500, "retries": 1,
         "backoff": {"policy": "fixed", "base_ms": 10, "jitter": False},
         "fallback_chain": {"order": ["cache", "none"]}},
        {"cache": cache, "key_input": {"provider": "acme", "model": "widget-v1", "prompt": {"q": "hello"}}},
    )
    result = wrapped()
    check("cache-hit returns golden value (no throw)", result == {"text": "golden hello"})
    check("cache-hit is not a DegradedResult", not is_degraded_result(result))
    check("primary attempted (retries+1) times before fallback", calls["n"] == 2)


def test_empty_cache_degrades() -> None:
    """Exhausted chain with no hits -> typed DegradedResult, never throws."""
    cache, _ = make_cache()

    def always_fails() -> str:
        raise ValueError("boom")

    wrapped = with_resilience(
        always_fails,
        {"retries": 0, "backoff": {"policy": "none"},
         "fallback_chain": {"order": ["cache", "replay", "none"]}},
        {"cache": cache, "key_input": {"provider": "acme", "model": "m", "prompt": {}}},
    )
    result = wrapped()
    ok = is_degraded_result(result)
    check("empty-cache path yields DegradedResult", ok)
    if ok:
        d = result
        check("degraded reason=primary_failed", d["reason"] == "primary_failed")
        check("degraded fallback_source=none", d["fallback_source"] == "none")
        check("degraded version=1.0.0 + discriminator true",
              d["version"] == "1.0.0" and d["degraded"] is True)
        check("original_error carried", "boom" in (d["original_error"] or ""))


# ------------------------------------------------------------------ check 3

def test_forced_degraded_skips_primary() -> None:
    """RES-07 kill switch: primary+secondary never invoked; cache still served."""
    cache, _ = make_cache()
    key = cache.derive_key("acme", "m", {"k": 1})
    cache.put(key, {"canned": True})
    calls = {"primary": 0, "secondary": 0}

    def primary() -> str:
        calls["primary"] += 1
        return "live"

    def secondary() -> str:
        calls["secondary"] += 1
        return "sec"

    wrapped = with_resilience(
        primary,
        {"forced_degraded": True, "fallback_chain":
         {"order": ["secondary_provider", "cache", "replay", "none"],
          "secondary_provider": {"enabled": True}}},
        {"cache": cache, "secondary_provider": secondary,
         "key_input": {"provider": "acme", "model": "m", "prompt": {"k": 1}}},
    )
    result = wrapped()
    check("forced_degraded: primary counter == 0", calls["primary"] == 0)
    check("forced_degraded: secondary skipped", calls["secondary"] == 0)
    check("forced_degraded: cache still served", result == {"canned": True})

    # Miss variant: terminal DegradedResult carries reason forced_degraded.
    cache2, _ = make_cache()
    wrapped2 = with_resilience(
        primary,
        {"forced_degraded": True, "retries": 3, "fallback_chain": {"order": ["cache", "none"]}},
        {"cache": cache2, "key_input": {"provider": "x", "model": "y", "prompt": {"z": 0}}},
    )
    r2 = wrapped2()
    check("forced_degraded miss: counter still 0", calls["primary"] == 0)
    check("forced_degraded miss: reason=forced_degraded",
          is_degraded_result(r2) and r2["reason"] == "forced_degraded")  # type: ignore[index]


# ------------------------------------------------------------------ check 4

def test_bad_configs_construct_and_run() -> None:
    """RES-AC-04: malformed/missing config -> safe defaults, wrapper functions."""
    bad_configs: list[object] = [
        None, {}, {"timeout_ms": -1}, {"retries": 99},
        {"backoff": {"policy": "yolo"}}, {"fallback_chain": {"order": ["warp"]}},
        "not-a-dict",
    ]
    all_ok = True
    for cfg in bad_configs:
        try:
            wrapped = with_resilience(lambda: "ok", cfg)  # type: ignore[arg-type]
            result = wrapped()
            if result != "ok":
                all_ok = False
        except Exception as exc:  # noqa: BLE001
            print(f"   config {cfg!r} raised {exc!r}")
            all_ok = False
    check("bad configs construct fine and run to 'ok'", all_ok)


# ------------------------------------------------------- async engine checks

async def test_async_retry_then_success() -> None:
    """RES-02: retries are ADDITIONAL attempts; backoff between them."""
    state = {"n": 0}

    async def flaky_async() -> str:
        state["n"] += 1
        if state["n"] < 3:
            raise RuntimeError("transient")
        return "recovered"

    wrapped = with_resilience(
        flaky_async,
        {"timeout_ms": 1000, "retries": 2, "backoff": {"policy": "fixed", "base_ms": 10, "jitter": False},
         "fallback_chain": {"order": ["none"]}},
    )
    result = await wrapped()
    check("async retry-then-success returns value", result == "recovered")
    check("async attempts == retries+1", state["n"] == 3)


async def test_async_timeout_maps_to_primary_timeout() -> None:
    """RES-02: asyncio.wait_for timeout -> retryable failure; terminal reason primary_timeout."""
    calls = {"n": 0}

    async def slow() -> str:
        calls["n"] += 1
        await asyncio.sleep(0.2)
        return "too late"

    wrapped = with_resilience(
        slow,
        {"timeout_ms": 100, "retries": 1, "backoff": {"policy": "none"},
         "fallback_chain": {"order": ["none"]}},
    )
    result = await wrapped()
    check("async timeout: attempts == retries+1", calls["n"] == 2)
    check("async timeout: reason=primary_timeout",
          is_degraded_result(result) and result["reason"] == "primary_timeout")  # type: ignore[index]


async def test_secondary_fallback() -> None:
    """RES-03 step 1: secondary_provider supplied out-of-band wins before cache."""
    cache, _ = make_cache()

    def primary() -> str:
        raise RuntimeError("primary down")

    def secondary() -> str:
        return "secondary data"

    wrapped = with_resilience(
        primary,
        {"retries": 0, "backoff": {"policy": "none"}, "fallback_chain":
         {"order": ["secondary_provider", "cache", "none"], "secondary_provider": {"enabled": True}}},
        {"cache": cache, "secondary_provider": secondary,
         "key_input": {"provider": "a", "model": "b", "prompt": {}}},
    )
    result = wrapped()
    check("secondary fallback returns secondary value", result == "secondary data")

    # Secondary throwing is contained; chain continues to next step.
    def bad_secondary() -> str:
        raise RuntimeError("sec down")

    wrapped2 = with_resilience(
        primary,
        {"retries": 0, "backoff": {"policy": "none"}, "fallback_chain":
         {"order": ["secondary_provider", "cache", "none"], "secondary_provider": {"enabled": True}}},
        {"cache": cache, "secondary_provider": bad_secondary,
         "key_input": {"provider": "a", "model": "b", "prompt": {}}},
    )
    r2 = wrapped2()
    check("secondary throw contained -> degraded (not throw)", is_degraded_result(r2))


async def test_replay_subspace() -> None:
    """RES-03 step 3: replay looks up replay::<base> subspace of the same store."""
    cache, _ = make_cache()
    key = cache.derive_key("acme", "m", {"r": 1})
    cache.put(REPLAY_PREFIX + key, {"replayed": True})

    def dead_primary() -> str:
        raise RuntimeError("offline")

    wrapped = with_resilience(
        dead_primary,
        {"retries": 0, "backoff": {"policy": "none"},
         "fallback_chain": {"order": ["cache", "replay", "none"]}},
        {"cache": cache, "key_input": {"provider": "acme", "model": "m", "prompt": {"r": 1}}},
    )
    result = wrapped()
    check("replay step serves replay::<key> value", result == {"replayed": True})


async def test_validation_repair_failed_reason() -> None:
    """RES-04 wiring: hook raising ValidationRepairFailed maps the terminal reason."""
    from resilience.validate import render_repair_prompt

    def bad_output() -> str:
        return "not json"

    def hook(_result: object) -> object:
        raise ValidationRepairFailed("schema invalid after repair", [{"path": "$", "message": "bad", "code": "format"}])

    wrapped = with_resilience(
        bad_output,
        {"retries": 1, "backoff": {"policy": "none"}, "fallback_chain": {"order": ["none"]}},
        {"validate_result": hook},
    )
    result = wrapped()
    check("ValidationRepairFailed -> reason validation_repair_failed",
          is_degraded_result(result) and result["reason"] == "validation_repair_failed")  # type: ignore[index]
    assert callable(render_repair_prompt)


async def test_internal_error_guard() -> None:
    """GOV-RES-04: even a non-callable target degrades instead of raising."""
    wrapped = with_resilience("definitely not callable", {"retries": 0, "fallback_chain": {"order": ["none"]}})  # type: ignore[arg-type]
    result = wrapped()
    check("non-callable target -> resilience_internal_error DegradedResult",
          is_degraded_result(result) and result["reason"] == "resilience_internal_error")  # type: ignore[index]


# ------------------------------------------------------------ sync variant checks

def test_sync_variant() -> None:
    """Sync path: wall-clock post-join deadline, cooperative only; wraps metadata."""
    def fast_sync() -> str:
        return "sync ok"

    wrapped = with_resilience(fast_sync, {"timeout_ms": 5000, "fallback_chain": {"order": ["cache", "none"]}},
                              {"cache": make_cache()[0]})
    check("sync fast path returns value", wrapped() == "sync ok")

    def slow_sync() -> str:
        import time as _t
        _t.sleep(0.15)
        return "late"

    wrapped_slow = with_resilience(
        slow_sync,
        {"timeout_ms": 100, "retries": 1, "backoff": {"policy": "fixed", "base_ms": 10, "jitter": False},
         "fallback_chain": {"order": ["none"]}},
    )
    r = wrapped_slow()
    check("sync over-deadline treated as timeout failure",
          is_degraded_result(r) and r["reason"] == "primary_timeout")  # type: ignore[index]

    def named(a: int, b: int = 2) -> int:
        return a + b

    wsum = with_resilience(named, {"retries": 0})
    check("signature preserved via functools.wraps", wsum.__name__ == "named" and wsum(1) == 3)
    check("functools.wraps metadata (__doc__/__wrapped__)", getattr(wsum, "__wrapped__", None) is not None)

    async def async_target() -> str:
        return "async!"

    wasync = with_resilience(async_target)
    check("iscoroutinefunction detection -> coroutine wrapper",
          inspect.iscoroutinefunction(wasync))


def test_decorator_alias() -> None:
    @resilient({"retries": 0, "fallback_chain": {"order": ["none"]}})
    def boom() -> str:
        raise RuntimeError("x")

    @resilient()
    async def aok() -> str:
        return "decorator async ok"

    r = boom()
    check("@resilient sync alias degrades without raising", is_degraded_result(r))
    ar = asyncio.run(aok())
    check("@resilient async alias returns value", ar == "decorator async ok")


def test_backoff_math() -> None:
    from resilience.config import resolve_config

    eff = resolve_config({"backoff": {"policy": "exponential", "base_ms": 100, "factor": 2.0,
                                     "max_ms": 500, "jitter": False}})
    vals = [compute_backoff_delay_ms(eff, i) for i in (1, 2, 3, 4)]
    check("exponential backoff 100/200/400/500(cap)", vals == [100, 200, 400, 500])
    eff_fixed = resolve_config({"backoff": {"policy": "fixed", "base_ms": 50, "jitter": False}})
    check("fixed backoff constant", compute_backoff_delay_ms(eff_fixed, 7) == 50)
    eff_none = resolve_config({"backoff": {"policy": "none", "jitter": False}})
    check("none backoff zero", compute_backoff_delay_ms(eff_none, 3) == 0)


# --------------------------------------------------------------------- main

def main() -> int:
    test_cache_hit_path()
    test_empty_cache_degrades()
    test_forced_degraded_skips_primary()
    test_bad_configs_construct_and_run()
    asyncio.run(test_async_retry_then_success())
    asyncio.run(test_async_timeout_maps_to_primary_timeout())
    asyncio.run(test_secondary_fallback())
    asyncio.run(test_replay_subspace())
    asyncio.run(test_validation_repair_failed_reason())
    asyncio.run(test_internal_error_guard())
    test_sync_variant()
    test_decorator_alias()
    test_backoff_math()
    failed = [name for ok, name in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
