# Requirement IDs: COST-01, COST-03, COST-RES-01, COST-REU-01, COST-REU-02, GOV-RES-04, RES-REU-02, CTX-02
"""Metering wrapper — DP-I §3.1, §5, §7.

with_cost_guardrail(fn, opts=None) mirrors RES-REU-02 (callable, sync or
async, raises on failure): coroutine fns get an async wrapper, everything
else a sync wrapper; signature preserved via functools.wraps. Metering is a
NON-throwing side effect (GOV-RES-04): the wrapped call's value/exception is
always passed through untouched; failed attempts still append an unmetered
record so request counts reflect attempts (COST-RES-01).

Count derivation priority (DP-I §5.1): provider-reported usage via
opts.usage_extractor wins; else CTX-02 counting over the result content —
imported from src.context.token_counter ONLY when importable, never
reimplemented here; else counts stay None and the record is unmetered with
reason missing_usage_data. Partial counts (output only) still count as
metered; only all-null token fields are unmetered.

Every public function is outer try/except bounded (GOV-RES-04). Zero imports
outside stdlib + src.cost (+ the single optional CTX-02 import) — standalone
per COST-REU-01.
"""

from __future__ import annotations

import functools
import inspect
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from .config import merge_budget_config
from .store import get_default_store
from .types import CostBudgetConfig, CostMeteringOpts, PartialUsageRecord, UsageRecord

_logger = logging.getLogger("cost.meter")

__all__ = ["with_cost_guardrail", "derive_token_counts", "build_usage_record"]

_DEFAULT_PROFILE = "generic-heuristic"  # DP-E §4.2 default via DP-I §4.1
_PROFILES_PATH = (
    Path(__file__).resolve().parents[2] / "contracts" / "tokenizer-profiles.json"
)
_UNATTRIBUTED = "_unattributed"  # §7 empty-tag grouping key
_WARNED_PROFILES: set = set()  # unknown-profile warns once per profile (§7)

# Reasons frozen by DP-I §4.2/§7 + this module's failure rows.
REASON_MISSING_USAGE = "missing_usage_data"
REASON_MALFORMED_USAGE = "malformed_provider_usage"
REASON_EMPTY_TAG = "empty_provider_tag"
REASON_INTERNAL_ERROR = "internal_metering_error"
REASON_INNER_CALL_ERROR = "inner_call_error"

CountsResult = Dict[str, Any]
"""derive_token_counts return: token fields + unmetered/reason metadata."""


def _warn(msg: str) -> None:
    """Single warn channel — mirrors DP-I §7 `warn:` lines. Never throws."""
    try:
        _logger.warning("%s", msg)
    except Exception:  # noqa: BLE001 — GOV-RES-04 outer bound
        pass


def _utc_now_iso() -> str:
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    except Exception:  # noqa: BLE001
        return ""


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# --- opts resolution (DP-I §4.1, §7 empty-tag row) ------------------------


def resolve_opts(opts: Optional[CostMeteringOpts]) -> Dict[str, Any]:
    """Validate + normalize CostMeteringOpts. Never throws (GOV-RES-04).

    provider/label must be non-empty after trim — empty → warn once per
    wrapper `[COST] empty provider/label — call will be unmetered` and flag
    the wrapper unmetered with reason empty_provider_tag; the call still
    proceeds (COST-RES-01).
    """
    try:
        o = opts if isinstance(opts, dict) else {}
        raw_provider = o.get("provider")
        raw_label = o.get("label")
        provider_text = str(raw_provider).strip() if isinstance(raw_provider, str) else ""
        label_text = str(raw_label).strip() if isinstance(raw_label, str) else ""
        tags_empty = not provider_text or not label_text
        if tags_empty:
            _warn("[COST] empty provider/label — call will be unmetered")
        return {
            "provider": provider_text.lower() or _UNATTRIBUTED,
            "provider_empty": not provider_text,
            "label": label_text,
            "tags_empty": tags_empty,
            "model_profile": (
                str(o["model_profile"]).strip()
                if isinstance(o.get("model_profile"), str) and o.get("model_profile").strip()
                else None
            ),
            "budget_config": o.get("budget_config") if isinstance(o.get("budget_config"), dict) else None,
            "store": o.get("store") if o.get("store") is not None else None,
            "on_warning": o.get("on_warning") if callable(o.get("on_warning")) else None,
            "usage_extractor": o.get("usage_extractor") if callable(o.get("usage_extractor")) else None,
            "estimate_cost_per_1k_tokens": (
                float(o["estimate_cost_per_1k_tokens"])
                if _is_number(o.get("estimate_cost_per_1k_tokens"))
                else None
            ),
        }
    except Exception as exc:  # noqa: BLE001 — GOV-RES-04 outer bound
        _warn(f"[COST] internal error resolving metering opts ({exc}) — call will be unmetered")
        return {
            "provider": _UNATTRIBUTED,
            "provider_empty": True,
            "label": "",
            "tags_empty": True,
            "model_profile": None,
            "budget_config": None,
            "store": None,
            "on_warning": None,
            "usage_extractor": None,
            "estimate_cost_per_1k_tokens": None,
        }


# --- model_profile resolution + CTX-02 reuse (DP-I §5) --------------------

_profiles_cache: Optional[Dict[str, Any]] = None


def _load_profiles() -> Dict[str, Any]:
    """Read contracts/tokenizer-profiles.json once (single source, M03-owned).
    Unreadable/corrupt map → {} — resolution falls back to the generic default.
    Never throws."""
    global _profiles_cache
    if _profiles_cache is not None:
        return _profiles_cache
    try:
        with open(_PROFILES_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        profiles = raw.get("profiles") if isinstance(raw, dict) else None
        _profiles_cache = profiles if isinstance(profiles, dict) else {}
    except Exception:  # noqa: BLE001 — missing map degrades to default profile
        _profiles_cache = {}
    return _profiles_cache


def provider_to_profile(provider: str) -> str:
    """Map a provider tag to a model_profile via tokenizer-profiles.json only
    (no hardcoded provider constants — COST-REU-02). Exact key match first,
    then the longest profile key that is a prefix of the provider; miss → the
    map's default_profile or the generic fallback (DP-E §4.2 / DP-I §5.1).
    """
    try:
        key = (provider or "").strip().lower()
        if not key:
            return _DEFAULT_PROFILE
        profiles = _load_profiles()
        if key in profiles:
            return key
        prefixed = [k for k in profiles if isinstance(k, str) and k and key.startswith(k)]
        if prefixed:
            return max(prefixed, key=len)
        default = _DEFAULT_PROFILE
        try:
            with open(_PROFILES_PATH, "r", encoding="utf-8") as fh:
                declared = json.load(fh).get("default_profile")
            if isinstance(declared, str) and declared:
                default = declared
        except Exception:  # noqa: BLE001 — keep generic fallback
            pass
        return default
    except Exception:  # noqa: BLE001 — GOV-RES-04 outer bound
        return _DEFAULT_PROFILE


def _ctx_counter() -> Optional[Tuple[Callable[..., int], Callable[..., int], Callable[..., int]]]:
    """Return CTX-02 counting functions when importable, else None.

    The single allowed intra-chassis import (COST-REU-02); when src.context is
    unavailable all counts stay None (never reimplemented here).
    """
    try:
        from src.context.token_counter import count, count_buffer, count_message  # type: ignore # noqa: E501

        return count, count_buffer, count_message  # type: ignore[return-value]
    except Exception:  # noqa: BLE001 — absent CTX-02 → heuristic path disabled
        return None


def _resolve_profile(resolved: Dict[str, Any]) -> str:
    """opts.model_profile → provider-prefix match → generic default (§4.1);
    unknown profile warns once per profile and proceeds (§7)."""
    explicit = resolved.get("model_profile")
    profile = str(explicit) if explicit else provider_to_profile(resolved["provider"])
    if profile not in _load_profiles() and profile not in _WARNED_PROFILES:
        _WARNED_PROFILES.add(profile)
        _warn(f'[COST] unknown model_profile "{profile}", using "{_DEFAULT_PROFILE}"')
    return profile


# --- count derivation (DP-I §5.1 priority order) --------------------------


def _extractor_counts(
    result: Any, usage_extractor: Optional[Callable[[Any], PartialUsageRecord]]
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Priority (a): provider-reported usage wins. Returns (counts, None) on
    success, (None, reason) when the extraction is unusable. A None/empty
    result falls through to the CTX-02 path; wrong-typed fields are malformed
    provider usage (COST-RES-01 — never throw)."""
    if usage_extractor is None:
        return None, None
    try:
        extracted = usage_extractor(result)
    except Exception as exc:  # noqa: BLE001 — extractor fault = malformed usage
        _warn(f'[COST] usage extractor raised ({exc}) — treating as malformed_provider_usage')
        return None, REASON_MALFORMED_USAGE
    if not isinstance(extracted, dict):
        if extracted is None:
            return None, None  # no provider usage → fall through
        return None, REASON_MALFORMED_USAGE
    fields = {k: extracted.get(k) for k in ("input_tokens", "output_tokens", "total_tokens")}
    if all(v is None for v in fields.values()):
        return None, None  # empty/all-null dict → fall through to counting
    for name, value in fields.items():
        if value is not None and not _is_number(value):
            try:
                rendered = json.dumps(value)
            except Exception:  # noqa: BLE001
                rendered = repr(value)
            _warn(f"[COST] malformed provider usage ({name}={rendered[:50]}) — ignoring")
            return None, REASON_MALFORMED_USAGE
    clean = {
        "input_tokens": int(fields["input_tokens"]) if fields["input_tokens"] is not None else None,
        "output_tokens": int(fields["output_tokens"]) if fields["output_tokens"] is not None else None,
        "total_tokens": int(fields["total_tokens"]) if fields["total_tokens"] is not None else None,
    }
    return clean, None


def _countable_content(result: Any) -> Optional[Any]:
    """Shape-match the result against countable content (§5.1): a string, a
    message dict with string content, or a message array. Anything else → None."""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, str):
            return result  # single message — counted via count_message
        return None
    if isinstance(result, list) and result and all(isinstance(m, dict) for m in result):
        return result  # message array — counted via count_buffer
    return None


def derive_token_counts(
    result: Any,
    opts: Dict[str, Any],
    usage_extractor: Optional[Callable[[Any], PartialUsageRecord]] = None,
) -> CountsResult:
    """DP-I §5.1 derivation: (a) provider-reported usage via usage_extractor;
    (b) CTX-02 heuristic counting over the result content (import attempted,
    never reimplemented); (c) all-None counts stay unmetered.

    Partial counts (output only) still count as metered; only when every
    token field is null does unmetered become True with reason
    missing_usage_data. Never throws on data-shape problems (COST-RES-01).
    """
    out: CountsResult = {
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "unmetered_reason": REASON_MISSING_USAGE,
    }
    try:
        # (a) provider-reported values win when present and well-typed.
        extracted, reason = _extractor_counts(result, usage_extractor)
        if reason is not None:
            out["unmetered_reason"] = reason
            return out
        if extracted is not None:
            out.update(extracted)
            out["unmetered_reason"] = ""
            return out
        # (b) CTX-02 reuse — absent counter or uncountable content → None.
        counter = _ctx_counter()
        if counter is None:
            return out
        content = _countable_content(result)
        if content is None:
            return out
        profile = _resolve_profile(opts)
        count, count_message_fn, count_buffer_fn = counter
        try:
            if isinstance(content, str):
                tokens = count(content, profile)
            elif isinstance(content, list):
                tokens = count_buffer_fn(content, profile)
            else:
                tokens = count_message_fn(content, profile)
        except Exception as exc:  # noqa: BLE001 — counting fault → unmetered
            _warn(f"[COST] internal error deriving token counts ({exc})")
            return out
        if _is_number(tokens):
            out["output_tokens"] = int(tokens)
            out["unmetered_reason"] = ""
        return out
    except Exception as exc:  # noqa: BLE001 — GOV-RES-04 outer bound
        _warn(f"[COST] internal error deriving token counts ({exc})")
        out["unmetered_reason"] = REASON_MISSING_USAGE
        return out


# --- record assembly (DP-I §4.2) ------------------------------------------


def _resolved_profile_name(resolved: Dict[str, Any]) -> str:
    """Non-empty resolved profile for §4.2 records: explicit opts.model_profile,
    else the provider-derived/default profile — never "" (the snapshot contract
    requires minLength 1, DP-I §4.2)."""
    try:
        explicit = resolved.get("model_profile")
        if isinstance(explicit, str) and explicit.strip():
            return explicit.strip()
        return provider_to_profile(str(resolved.get("provider") or ""))
    except Exception:  # noqa: BLE001 — GOV-RES-04
        return _DEFAULT_PROFILE


def build_usage_record(
    result: Any, counts: CountsResult, resolved: Dict[str, Any]
) -> UsageRecord:
    """Assemble one UsageRecord per §4.2: uuid4 id, ISO timestamp,
    lowercased provider, request_count 1; estimated_cost_usd =
    total_tokens/1000 * estimate_cost_per_1k_tokens when the rate is supplied
    and a total exists, else None. All-null token fields → unmetered True.
    Never throws (GOV-RES-04)."""
    record: UsageRecord = {
        "id": str(uuid.uuid4()),
        "timestamp": _utc_now_iso(),
        "provider": str(resolved.get("provider") or _UNATTRIBUTED).strip().lower(),
        "label": str(resolved.get("label") or ""),
        "model_profile": _resolved_profile_name(resolved),
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "request_count": 1,
        "estimated_cost_usd": None,
        "unmetered": True,
        "unmetered_reason": REASON_MISSING_USAGE,
        "raw_usage_ref": None,
    }
    try:
        input_tokens = counts.get("input_tokens")
        output_tokens = counts.get("output_tokens")
        total_supplied = counts.get("total_tokens")
        if input_tokens is not None and output_tokens is not None:
            total: Optional[int] = input_tokens + output_tokens
        else:
            total = total_supplied  # supplied directly, else None
        record["input_tokens"] = input_tokens
        record["output_tokens"] = output_tokens
        record["total_tokens"] = total
        rate = resolved.get("estimate_cost_per_1k_tokens")
        if total is not None and _is_number(rate):
            record["estimated_cost_usd"] = total / 1000 * float(rate)
        metered = any(v is not None for v in (input_tokens, output_tokens, total))
        record["unmetered"] = not metered
        record["unmetered_reason"] = (
            "" if metered else str(counts.get("unmetered_reason") or REASON_MISSING_USAGE)
        )
    except Exception as exc:  # noqa: BLE001 — keep an unmetered record on fault
        _warn(f"[COST] internal error building usage record ({exc})")
    return record


# --- metering wrapper (DP-I §3.1, §7) -------------------------------------


def _minimal_record(resolved: Dict[str, Any], reason: str) -> UsageRecord:
    """All-null-counts record for attempts that produced no usable usage."""
    return {
        "id": str(uuid.uuid4()),
        "timestamp": _utc_now_iso(),
        "provider": str(resolved.get("provider") or _UNATTRIBUTED).strip().lower(),
        "label": str(resolved.get("label") or ""),
        "model_profile": _resolved_profile_name(resolved),
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "request_count": 1,
        "estimated_cost_usd": None,
        "unmetered": True,
        "unmetered_reason": reason,
        "raw_usage_ref": None,
    }


def _meter_success(result: Any, resolved: Dict[str, Any], store: Any, fired: set) -> None:
    """Non-throwing side effect (GOV-RES-04): derive counts, append record,
    check budgets with the merged config, fan warnings out to the
    opts.on_warning callback AND the store registry — swallowing handler
    errors. On any internal fault an unmetered internal_metering_error record
    is appended instead; the wrapped call's result is never touched.

    Warning emission is edge-triggered per wrapper (§3.5 once_per_threshold):
    a (scope, level) pair fires through this wrapper once until the warning
    stops being active; the store registry additionally dedupes globally.
    """
    try:
        counts = derive_token_counts(result, resolved, resolved.get("usage_extractor"))
        record = build_usage_record(result, counts, resolved)
        if resolved.get("tags_empty"):
            record["unmetered"] = True
            record["unmetered_reason"] = REASON_EMPTY_TAG
        store.append(record)
        effective = merge_budget_config(store.get_budget_config(), resolved.get("budget_config"))
        warnings = store.check_budget(effective)
        callback = resolved.get("on_warning")
        for warning in warnings:
            key = (str(warning.get("scope")), str(warning.get("level")))
            if key in fired:
                continue  # edge-triggered — already emitted for this crossing
            fired.add(key)
            if callback is not None:
                try:
                    callback(warning)
                except Exception as exc:  # noqa: BLE001 — handler errors swallowed
                    _warn(f"[COST] warning handler error (swallowed): {exc}")
            try:
                store.emit_warning(warning)
            except Exception as exc:  # noqa: BLE001 — registry faults swallowed
                _warn(f"[COST] internal error emitting warning ({exc})")
    except Exception as exc:  # noqa: BLE001 — metering itself failed
        try:
            _warn(f"[COST] internal error — {exc}")
            store.append(_minimal_record(resolved, REASON_INTERNAL_ERROR))
        except Exception:  # noqa: BLE001 — last-resort swallow (§7)
            pass


def with_cost_guardrail(
    fn: Callable[..., Any], opts: Optional[CostMeteringOpts] = None
) -> Callable[..., Any]:
    """Wrap any RES-REU-02 callable (sync or async, raises on failure) so each
    invocation is metered into a CostStore (COST-01).

    Guarantees (DP-I §7 / GOV-RES-04):
    - the inner callable's return value is ALWAYS returned unwrapped;
    - the inner callable's exceptions PROPAGATE untouched (no DegradedResult —
      RES-06 owns that), after an unmetered attempt record is appended so
      failed requests still count toward the budget;
    - metering failures never surface — an internal_metering_error record is
      appended and the inner result is returned regardless;
    - coroutine functions get a matching async wrapper that awaits the inner
      call BEFORE metering.
    """
    if not callable(fn):
        raise TypeError("with_cost_guardrail expects a callable")
    resolved = resolve_opts(opts)  # validated once per wrapper; warns on empty tags
    store = resolved["store"] if resolved["store"] is not None else get_default_store()
    fired: set = set()  # edge-trigger state for this wrapper (§3.5)

    def _meter_failure() -> None:
        """Count a failed attempt toward the budget — never raises."""
        try:
            store.append(_minimal_record(resolved, REASON_INNER_CALL_ERROR))
        except Exception as exc:  # noqa: BLE001 — swallow per §7
            _warn(f"[COST] internal error recording failed attempt ({exc})")

    if inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(getattr(fn, "__call__", None)):

        @functools.wraps(fn)
        async def metered_call(*args: Any, **kwargs: Any) -> Any:
            try:
                result = await fn(*args, **kwargs)  # domain errors propagate
            except Exception:
                _meter_failure()
                raise
            _meter_success(result, resolved, store, fired)
            return result  # always — even if metering threw internally

        return metered_call

    @functools.wraps(fn)
    def metered_call_sync(*args: Any, **kwargs: Any) -> Any:
        try:
            result = fn(*args, **kwargs)  # domain errors propagate
        except Exception:
            _meter_failure()
            raise
        _meter_success(result, resolved, store, fired)
        return result  # always — even if metering threw internally

    return metered_call_sync
