# Requirement IDs: RES-01, RES-02, RES-03, RES-07, RES-REU-02, RES-RES-03, GOV-RES-01, GOV-RES-04, XCUT-08
"""Central resilience wrapper — DP-A §3.1/§3.3/§3.4, §4.1, §7.

with_resilience(fn, config=None, deps=None) -> callable returning T or
DegradedResult. Iterative retry loop with timeout + backoff+jitter (RES-02),
ordered fallback chain secondary_provider -> cache -> replay -> DegradedResult
(RES-03), forced-degraded kill switch (RES-07), and an outermost guard that
maps ANY internal failure to DegradedResult{reason:"resilience_internal_error"}
(RES-RES-03, GOV-RES-04). Never raises unhandled. Domain-free (GOV-REU-02);
imports only sibling resilience modules (RES-REU-01).
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import logging
import random
import time
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Mapping,
    Optional,
    TypeVar,
    Union,
)

from .cache import REPLAY_PREFIX, GoldenCache, create_golden_cache
from .config import EffectiveConfig, ResilienceConfig, create_config_resolver
from .degraded import DegradedResult, FallbackSource, make_degraded_result
from .validate import (
    ValidationError,
    ValidationRepairFailed,
    _complete_repair,
    render_repair_prompt,
    validate,
)

_logger = logging.getLogger("resilience.wrapper")

T = TypeVar("T")

#region Callable contract (DP-A §4.1)

ResilientCallable = Callable[[], Union[T, Awaitable[T]]]  # type: ignore[misc]
WrappedCallable = Callable[[], Awaitable[Union[T, "DegradedResult"]]]  # type: ignore[misc]

#endregion


#region Dependencies (out-of-band — never serialized into config)


class WrapperDeps(Dict[str, Any]):
    """Out-of-band dependency mapping. Recognized keys:

    - ``secondary_provider``: step 1 of the fallback chain (a real callable,
      not a string lookup).
    - ``cache``: GoldenCache used by the cache/replay steps; defaults to a
      process-wide instance rooted at <cwd>/.cache/golden (or GOLDEN_CACHE_DIR).
    - ``cache_key``: explicit base key; overrides strategy resolution.
    - ``key_input``: ``{provider, model, prompt}`` material for the "auto"
      strategy (sha256(provider|model|input_hash)).
    - ``repair_llm``: LLM callable used by ``with_validation`` for the single
      self-repair round-trip (DP-A §6.2). Supplied out-of-band like
      ``secondary_provider`` — NEVER serialized into config. Repair inherits
      timeout_ms.
    - ``validate_result``: optional structured-output enforcement hook; raising
      ValidationRepairFailed routes into the fallback chain with reason
      "validation_repair_failed". Installed by ``with_validation``; consumers
      pass ``schema`` instead of authoring hooks.
    """


def _deps_get(deps: Optional[Mapping[str, Any]], key: str) -> Any:
    if not deps:
        return None
    try:
        return deps.get(key)
    except AttributeError:
        return None


#endregion


#region Backoff computation (DP-A §4.2, §7.1)


def compute_backoff_delay_ms(effective: EffectiveConfig, attempt: int) -> int:
    """Delay before retry `attempt` (1-based) per the backoff policy.

    exponential base*factor^(attempt-1) | linear base*attempt | fixed base |
    none 0. Capped at max_ms; +/-25% uniform jitter applied last. Deterministic
    when jitter is disabled.
    """
    backoff = effective["backoff"]
    policy = backoff["policy"]
    if policy == "none":
        return 0
    base_ms = backoff["base_ms"]
    if policy == "exponential":
        raw = base_ms * (backoff["factor"] ** (attempt - 1))
    elif policy == "linear":
        raw = base_ms * attempt
    else:  # fixed
        raw = float(base_ms)
    delay = min(int(round(raw)), backoff["max_ms"])
    if not backoff["jitter"]:
        return max(0, delay)
    factor = random.uniform(0.75, 1.25)  # [0.75, 1.25] uniform
    return max(0, int(round(delay * factor)))


def _sleep_sync(ms: int) -> None:
    """Synchronous sleep for the sync path (busy-blocks briefly; bounded by max_ms)."""
    if ms <= 0:
        return
    stop = time.monotonic() + ms / 1000.0
    while time.monotonic() < stop:
        time.sleep(min(0.005, max(0.0, stop - time.monotonic())))


#endregion


#region Key resolution (DP-A §5.2, §7.1)


def _resolve_base_key(
    effective: EffectiveConfig,
    deps: Optional[Mapping[str, Any]],
    cache: GoldenCache,
) -> Optional[str]:
    """Base key for the cache step (direct) and replay step (replay::<base>).

    Returns None when no key material is available — stages then report a miss.
    """
    cache_key = _deps_get(deps, "cache_key")
    if isinstance(cache_key, str) and cache_key:
        return cache_key
    if effective["cache_key_strategy"] == "explicit":
        explicit = effective["cache_key_explicit"]
        if isinstance(explicit, str) and explicit:
            return explicit
    key_input = _deps_get(deps, "key_input")
    if isinstance(key_input, Mapping):
        return cache.derive_key(
            key_input.get("provider", ""),
            key_input.get("model", ""),
            key_input.get("prompt"),
        )
    return None


#endregion


#region Runtime — iterative retry loop + ordered fallback chain (DP-A §3.3/§3.4)


def _normalize_error(err: BaseException) -> str:
    """Normalize any throwable to a string message (§8 contract row)."""
    if isinstance(err, ValidationRepairFailed):
        return str(err) or "validation repair failed"
    try:
        return str(err)
    except Exception:  # pragma: no cover - unstringable exotic throwable
        return repr(err)


class _ResilienceRuntime:
    """Per-wrapper runtime resolved ONCE at creation (§3.2 hot path).

    Holds the cached EffectiveConfig accessor, the target callable, out-of-band
    deps, and the (lazily-built) GoldenCache so the hot path stays allocation-light.
    """

    def __init__(
        self,
        fn: Callable[..., Any],
        config: Optional[ResilienceConfig] = None,
        deps: Optional[Mapping[str, Any]] = None,
    ) -> None:
        self._fn = fn
        self._deps: Mapping[str, Any] = deps or {}
        self._get_effective = create_config_resolver(config)
        self._cache: Optional[GoldenCache] = None

    @property
    def cache(self) -> GoldenCache:
        if self._cache is None:
            supplied = _deps_get(self._deps, "cache")
            self._cache = supplied if isinstance(supplied, GoldenCache) else create_golden_cache()
        return self._cache

    # -- helpers ------------------------------------------------------------

    def _stage_context(self) -> Dict[str, Any]:
        effective = self._get_effective()
        base_key: Optional[str] = None
        try:
            base_key = _resolve_base_key(effective, self._deps, self.cache)
        except Exception as err:  # GOV-RES-04 containment for key derivation
            _logger.warning(
                "resilience warn: cache key derivation failed (%s); cache/replay stages will miss",
                _normalize_error(err),
            )
        return {
            "effective": effective,
            "forced_degraded": bool(effective["forced_degraded"]),
            "base_key": base_key,
        }

    def _run_validate_hook(self, result: Any) -> Any:
        """Sync-position validation hook: an awaitable outcome cannot be joined
        here, so it is converted into ValidationRepairFailed — the RES-03
        machinery then degrades via the fallback chain instead of leaking an
        internal coroutine to the caller (never-throw, RES-RES-03/GOV-RES-04)."""
        hook = _deps_get(self._deps, "validate_result")
        if hook is None:
            return result
        out = hook(result)
        if inspect.isawaitable(out):
            _logger.warning(
                "resilience warn: validate_result hook returned an awaitable in "
                "sync position; cannot join — routing to fallback chain"
            )
            raise ValidationRepairFailed(
                "validate_result hook returned an awaitable in sync position; "
                "async continuation cannot be joined synchronously",
                [],
            )
        return out

    async def _await_validate_hook(self, result: Any) -> Any:
        """Async-position validation hook: awaits async validate_result outcomes."""
        hook = _deps_get(self._deps, "validate_result")
        if hook is None:
            return result
        out = hook(result)
        if inspect.isawaitable(out):
            out = await out
        return out

    @staticmethod
    def _terminal(last_error: Optional[BaseException], forced_degraded: bool) -> DegradedResult:
        """Terminal DegradedResult reason mapping (§4.3 examples, §7.3, §8)."""
        if isinstance(last_error, ValidationRepairFailed):
            reason = "validation_repair_failed"
        elif forced_degraded:
            reason = "forced_degraded"
        elif isinstance(last_error, asyncio.TimeoutError):
            reason = "primary_timeout"
        elif last_error is not None and "timed out after" in _normalize_error(last_error):
            reason = "primary_timeout"
        else:
            reason = "primary_failed"
        return make_degraded_result(
            reason=reason,
            fallback_source="none",
            original_error=None if last_error is None else _normalize_error(last_error),
        )

    # -- async core ---------------------------------------------------------

    async def run_async(self, call: ResilientCallable[Any]) -> Union[Any, DegradedResult]:
        ctx = self._stage_context()
        effective: EffectiveConfig = ctx["effective"]
        forced = ctx["forced_degraded"]
        last_error: Optional[BaseException] = None

        # RES-02 retry loop - ITERATIVE; retries = ADDITIONAL attempts.
        if not forced:
            for attempt in range(effective["retries"] + 1):
                try:
                    raw = call()
                    value = raw
                    if inspect.isawaitable(value):
                        value = await asyncio.wait_for(value, timeout=effective["timeout_ms"] / 1000.0)
                    return await self._await_validate_hook(value)
                except Exception as err:  # noqa: BLE001 - containment boundary
                    last_error = err
                    if isinstance(last_error, ValidationRepairFailed):
                        # Exactly-one repair semantics (DP-A §6.2): a failed repair
                        # is terminal for the primary stage — never re-run
                        # primary/repair; enter RES-03 now.
                        break
                    if attempt < effective["retries"]:
                        delay_ms = compute_backoff_delay_ms(effective, attempt + 1)
                        if delay_ms > 0:
                            await asyncio.sleep(delay_ms / 1000.0)
        else:
            last_error = RuntimeError("skipped: forced_degraded kill switch active (RES-07)")

        # RES-03 fallback chain - array position is the sole authority; disabled
        # steps skipped silently; each stage individually guarded (§3.4).
        for step in effective["fallback_chain"]["order"]:
            if step == "none":
                break  # terminal marker
            step_cfg = effective["fallback_chain"].get(step, {})
            if not step_cfg.get("enabled", False):
                continue
            try:
                if step == "secondary_provider":
                    if not forced:
                        secondary = _deps_get(self._deps, "secondary_provider")
                        if callable(secondary):
                            raw_secondary = secondary()
                            if inspect.isawaitable(raw_secondary):
                                raw_secondary = await asyncio.wait_for(
                                    raw_secondary, timeout=effective["timeout_ms"] / 1000.0
                                )
                            return await self._await_validate_hook(raw_secondary)
                    continue
                if step in ("cache", "replay"):
                    base_key = ctx["base_key"]
                    if base_key is None:
                        continue
                    key = REPLAY_PREFIX + base_key if step == "replay" else base_key
                    hit = self.cache.get(key)
                    if hit is not None:
                        return hit
                    continue  # miss -> next step
            except Exception as err:  # noqa: BLE001 - per-stage containment
                _logger.warning(
                    "resilience warn: fallback step %s failed (%s); continuing down the chain",
                    step,
                    _normalize_error(err),
                )
                if step == "secondary_provider":
                    last_error = err
                continue

        return self._terminal(last_error, forced)

    # -- sync core ----------------------------------------------------------

    def run_sync(self, call: ResilientCallable[Any]) -> Union[Any, DegradedResult]:
        """Sync output variant: wall-clock deadline check AFTER the call joins
        (cooperative only - no thread kill, GOV-RES-04). Awaitable results cannot
        be joined here; they pass through as-is with a structured warn."""
        try:
            ctx = self._stage_context()
            effective: EffectiveConfig = ctx["effective"]
            forced = ctx["forced_degraded"]
            last_error: Optional[BaseException] = None

            if not forced:
                for attempt in range(effective["retries"] + 1):
                    started = time.monotonic()
                    try:
                        raw = call()
                        if inspect.isawaitable(raw):
                            _logger.warning(
                                "resilience warn: sync wrapper received an awaitable; "
                                "returning as-is without timeout enforcement"
                            )
                            return raw
                        elapsed_ms = int((time.monotonic() - started) * 1000)
                        if elapsed_ms > effective["timeout_ms"]:
                            raise TimeoutError(
                                f"primary callable timed out after {elapsed_ms}ms (primary_timeout, post-join)"
                            )
                        return self._run_validate_hook(raw)
                    except Exception as err:  # noqa: BLE001 - containment boundary
                        last_error = err
                        if isinstance(last_error, ValidationRepairFailed):
                            # Exactly-one repair semantics (DP-A §6.2): a failed
                            # repair is terminal for the primary stage — never
                            # re-run primary/repair; enter RES-03 now.
                            break
                        if attempt < effective["retries"]:
                            _sleep_sync(compute_backoff_delay_ms(effective, attempt + 1))
            else:
                last_error = RuntimeError("skipped: forced_degraded kill switch active (RES-07)")

            # Sync variant consults synchronous stages: sync secondary_provider and
            # the file-local GoldenCache (Python cache API is synchronous).
            for step in effective["fallback_chain"]["order"]:
                if step == "none":
                    break
                step_cfg = effective["fallback_chain"].get(step, {})
                if not step_cfg.get("enabled", False):
                    continue
                try:
                    if step == "secondary_provider":
                        if not forced:
                            secondary = _deps_get(self._deps, "secondary_provider")
                            if callable(secondary):
                                value = secondary()
                                if inspect.isawaitable(value):
                                    _logger.warning(
                                        "resilience warn: fallback step secondary_provider returned "
                                        "an awaitable in sync wrapper; skipping"
                                    )
                                else:
                                    return value
                        continue
                    if step in ("cache", "replay"):
                        base_key = ctx["base_key"]
                        if base_key is None:
                            continue
                        key = REPLAY_PREFIX + base_key if step == "replay" else base_key
                        hit = self.cache.get(key)
                        if hit is not None:
                            return hit
                        continue  # miss -> next step
                except Exception as err:  # noqa: BLE001 - per-stage containment
                    _logger.warning(
                        "resilience warn: fallback step %s failed (%s); continuing down the chain",
                        step,
                        _normalize_error(err),
                    )
                    continue

            return self._terminal(last_error, forced)
        except Exception as err:  # noqa: BLE001 - outermost guard
            _logger.warning(
                "resilience warn: resilience internal error (%s); degrading gracefully",
                _normalize_error(err),
            )
            return make_degraded_result(
                reason="resilience_internal_error", fallback_source="none", original_error=_normalize_error(err)
            )


#endregion


#region Public entry points (DP-A §3.1)


async def _guarded_async(runtime: "_ResilienceRuntime", call: ResilientCallable[Any]) -> Union[Any, DegradedResult]:
    """Outermost guard (GOV-RES-04 / RES-RES-03): nothing escapes unhandled."""
    try:
        return await runtime.run_async(call)
    except Exception as err:  # noqa: BLE001
        message = _normalize_error(err)
        _logger.warning(
            "resilience warn: resilience internal error (%s); degrading gracefully", message
        )
        return make_degraded_result(
            reason="resilience_internal_error", fallback_source="none", original_error=message
        )


def with_resilience(
    fn: Callable[..., Any],
    config: Optional[ResilienceConfig] = None,
    deps: Optional[Mapping[str, Any]] = None,
) -> Callable[..., Any]:
    """Wrap ``fn`` with timeout+retry+backoff and the ordered fallback chain.

    Returns a signature-preserving wrapper (functools.wraps). Async targets get
    an async wrapper; sync targets get a sync wrapper that still never throws.
    Config is resolved ONCE here into a cached EffectiveConfig (§3.2).
    """
    runtime = _ResilienceRuntime(fn, config, deps)

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def awrapper(*args: Any, **kwargs: Any) -> Union[Any, DegradedResult]:
            try:
                call = functools.partial(fn, *args, **kwargs)
                return await _guarded_async(runtime, call)
            except Exception as err:  # noqa: BLE001 - outermost guard
                message = _normalize_error(err)
                _logger.warning(
                    "resilience warn: resilience internal error (%s); degrading gracefully", message
                )
                return make_degraded_result(
                    reason="resilience_internal_error",
                    fallback_source="none",
                    original_error=message,
                )

        return awrapper

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Union[Any, DegradedResult]:
        try:
            call = functools.partial(fn, *args, **kwargs)
            return runtime.run_sync(call)
        except Exception as err:  # noqa: BLE001 - outermost guard
            message = _normalize_error(err)
            _logger.warning(
                "resilience warn: resilience internal error (%s); degrading gracefully", message
            )
            return make_degraded_result(
                reason="resilience_internal_error", fallback_source="none", original_error=message
            )

    return wrapper


def resilient(
    config: Optional[ResilienceConfig] = None,
    deps: Optional[Mapping[str, Any]] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator alias (DP-A §3.1 "decorator as thin alias")."""

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        return with_resilience(fn, config, deps)

    return decorator


#endregion


#region Structured-output enforcement — with_validation (DP-A §4.4 x RES-01, §6)


def _make_validation_hook(
    schema: Dict[str, Any], repair_llm: Optional[Any]
) -> Callable[[Any], Any]:
    """Builds the deps["validate_result"] hook (RES-04 wired into RES-01).

    Validates the callable's output against ``schema``; on invalid output runs
    repair() EXACTLY ONCE via render_repair_prompt + the out-of-band
    deps["repair_llm"]; on second failure raises ValidationRepairFailed, which
    the fallback machinery converts to
    DegradedResult{reason:"validation_repair_failed"} (DP-A §6.4).
    Returns a sync-or-async callable; async outcomes are awaited by run_async.
    """

    def hook(raw: Any) -> Any:
        if isinstance(raw, str):
            # Callables commonly return raw JSON text (LLM completions) — parse first.
            original_text = raw
            try:
                candidate: Any = json.loads(raw)
            except json.JSONDecodeError:
                candidate = None  # unparseable -> root type error -> repair path
        else:
            try:
                original_text = json.dumps(raw, default=str)
            except (TypeError, ValueError):
                original_text = str(raw)  # cyclic / non-serializable payload
            candidate = raw

        first = validate(schema, candidate)
        if first["valid"]:
            return candidate
        if repair_llm is None:
            raise ValidationRepairFailed(
                "output failed schema validation and no repair_llm was supplied",
                first["errors"],
            )

        def re_prompt(errors: List[ValidationError]) -> str:
            return render_repair_prompt(errors, original_text)

        # Exactly-one repair round-trip (DP-A §6.2): the LLM is invoked ONCE, here.
        # A SYNC repair_llm completes synchronously so the sync wrapper returns the
        # repaired value directly; an ASYNC one yields a coroutine that run_async
        # awaits via _await_validate_hook. Both tails share _complete_repair
        # semantics: on second-stage failure raise ValidationRepairFailed, which
        # the fallback machinery converts to DegradedResult{
        # reason:"validation_repair_failed"} (DP-A §6.4).
        try:
            raw_out = repair_llm(re_prompt(first["errors"]))
        except Exception as exc:  # noqa: BLE001 - wrapped into the internal signal
            raise ValidationRepairFailed(
                f"repair call_llm failed: {exc}", first["errors"]
            ) from exc

        if inspect.isawaitable(raw_out):
            async def _repaired() -> Any:
                try:
                    text = await raw_out
                except Exception as exc:  # noqa: BLE001 - internal signal conversion
                    raise ValidationRepairFailed(
                        f"repair call_llm failed: {exc}", first["errors"]
                    ) from exc
                return _complete_repair(schema, text, first["errors"])["data"]

            return _repaired()

        return _complete_repair(schema, raw_out, first["errors"])["data"]

    return hook


def with_validation(
    fn: Callable[..., Any],
    schema: Dict[str, Any],
    config: Optional[ResilienceConfig] = None,
    deps: Optional[Mapping[str, Any]] = None,
) -> Callable[..., Any]:
    """Wrap ``fn`` AND enforce structured-output validation on its result.

    DP-A §6.1/§6.4: valid output passes through unchanged (parsed when the
    callable returned a JSON string); invalid output triggers exactly one
    self-repair round-trip using the generic template + deps["repair_llm"]; a
    second validation failure raises the internal ValidationRepairFailed, which
    the step-5 RES-03 machinery catches and converts to DegradedResult{
    reason:"validation_repair_failed", fallback_source:<step or "none">}.

    ``repair_llm`` is supplied out-of-band via deps like secondary_provider
    (never serialized into config). The repair call inherits timeout_ms;
    consumers may set retries:1 to avoid latency amplification (DP-A §6.2).
    For tolerance with plan-style call sites, deps["repair_llm"] wins over an
    optional config["repair_llm"].
    """
    merged: Dict[str, Any] = dict(deps or {})
    from_config = None
    if isinstance(config, Mapping):
        from_config = config.get("repair_llm")
    repair_llm = merged.get("repair_llm") or from_config
    merged["validate_result"] = _make_validation_hook(schema, repair_llm)
    return with_resilience(fn, config, merged)


#endregion
