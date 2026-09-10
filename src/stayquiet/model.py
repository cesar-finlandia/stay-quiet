# StayQuiet — the ONLY place a model is reached (blueprint §2.4 rows 9-15, §2.4c rule 2).
#
#   build_agent()  constructs the Strands agent on an Amazon Bedrock model
#   run_agent()    invokes it, wrapped by resilience (outer) and cost metering (inner)
#
# Nothing else in this repository constructs a BedrockModel, invokes a Strands
# Agent, calls boto3, or applies with_resilience / with_cost_guardrail. Domain-free
# by design: no prompt text and no booking/policy field name appears in this file.
from __future__ import annotations

import hashlib
import json
import sys
from typing import Any, Optional, TypedDict

from src.resilience import (
    create_golden_cache,
    is_degraded_result,
    with_resilience,
)
from src.cost import get_default_store, with_cost_guardrail
from src.stayquiet.config import load_app_config, repo_root

#: Provider tag used for cost metering and for the tokenizer profile lookup.
PROVIDER_TAG: str = "bedrock"

#: Caller label recorded on every metered usage record.
COST_LABEL: str = "stayquiet-agent"


class LlmResult(TypedDict):
    """One completed model turn, in every outcome including failure.

    `source` is "live" for a real Bedrock turn, "cache" when the golden cache
    answered, and "none" when there was neither. `degraded` is True whenever
    source is not "live".
    """

    text: str
    degraded: bool
    reason: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    source: str  # "live" | "cache" | "none"


def result_text(result: Any) -> str:
    """Plain text of a Strands AgentResult, tolerant of every shape it may take.

    Handles: a dict message with a `content` list of `{"text": …}` blocks, a plain
    string message, and anything else via str(result). Never raises, never returns
    None; returns "" only when there was genuinely no text.
    """
    try:
        msg = getattr(result, "message", None)
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, list):
                return "".join(
                    b["text"] for b in content
                    if isinstance(b, dict) and isinstance(b.get("text"), str)
                )
            if isinstance(msg.get("text"), str):
                return msg["text"]
        if isinstance(msg, str) and msg:
            return msg
    except Exception:
        pass
    try:
        return str(result) if result is not None else ""
    except Exception:
        return ""


def usage_from_result(result: Any) -> dict:
    """Best-effort {input_tokens, output_tokens} from a Strands AgentResult.

    Reads result.metrics.accumulated_usage, then result.metrics.get_summary()'s
    accumulated_usage, then result.usage, accepting both camelCase (inputTokens)
    and snake_case (input_tokens) keys. Missing counts come back as None — never
    guessed, never estimated here. Never raises.
    """
    KEYS_IN = ("inputTokens", "input_tokens", "prompt_tokens")
    KEYS_OUT = ("outputTokens", "output_tokens", "completion_tokens")
    none_result = {"input_tokens": None, "output_tokens": None}
    try:
        candidates: list[Any] = []
        try:
            candidates.append(getattr(getattr(result, "metrics", None), "accumulated_usage", None))
        except Exception:
            pass
        try:
            metrics = getattr(result, "metrics", None)
            summary_fn = getattr(metrics, "get_summary", None)
            if callable(summary_fn):
                summary = summary_fn()
                candidates.append(summary.get("accumulated_usage") if isinstance(summary, dict) else None)
        except Exception:
            pass
        try:
            candidates.append(getattr(result, "usage", None))
        except Exception:
            pass
        try:
            if isinstance(result, dict):
                candidates.append(result.get("usage"))
        except Exception:
            pass
        for cand in candidates:
            if not isinstance(cand, dict):
                continue
            in_val: Any = None
            out_val: Any = None
            for k in KEYS_IN:
                if cand.get(k) is not None:
                    in_val = cand.get(k)
                    break
            for k in KEYS_OUT:
                if cand.get(k) is not None:
                    out_val = cand.get(k)
                    break
            if in_val is None and out_val is None:
                continue
            try:
                in_val = int(in_val) if in_val is not None else None
            except (TypeError, ValueError):
                in_val = None
            try:
                out_val = int(out_val) if out_val is not None else None
            except (TypeError, ValueError):
                out_val = None
            return {"input_tokens": in_val, "output_tokens": out_val}
        return dict(none_result)
    except Exception:
        return dict(none_result)


def usage_extractor(result: Any) -> Optional[dict]:
    """The `CostMeteringOpts.usage_extractor` hook: reads the token counts off the
    dict returned by the inner callable. Returns None when neither count is known,
    so the cost meter records the call as unmetered rather than as zero."""
    try:
        if not isinstance(result, dict):
            return None
        in_val = result.get("input_tokens")
        out_val = result.get("output_tokens")
        if in_val is None and out_val is None:
            return None
        return {"input_tokens": in_val, "output_tokens": out_val}
    except Exception:
        return None


def build_agent(tools: list | None = None, system_prompt: str | None = None) -> Any:
    """Construct the Strands agent for StayQuiet on an Amazon Bedrock model.

    Uses AppConfig["model_id"] and AppConfig["region"]. `tools` is the list of
    @tool callables the loop may choose from; `system_prompt` is the loop's
    instruction text. Raises only if the Strands SDK itself is unusable — that is
    a build error, not a runtime condition, and run_agent() never calls this.
    """
    from strands import Agent
    from strands.models import BedrockModel

    cfg = load_app_config()
    try:
        model = BedrockModel(
            model_id=cfg["model_id"],
            region_name=cfg["region"],
            temperature=0.2,
            max_tokens=1200,
        )
    except TypeError:
        print("[stayquiet] BedrockModel rejected temperature/max_tokens; using defaults",
              file=sys.stderr)
        model = BedrockModel(model_id=cfg["model_id"], region_name=cfg["region"])
    return Agent(model=model, tools=list(tools or []), system_prompt=system_prompt or "")


def _live_turn(agent: Any, prompt: str) -> dict:
    """The real Bedrock turn. Returns the dict shape the cache also stores."""
    result = agent(prompt)
    usage = usage_from_result(result)
    return {
        "text": result_text(result),
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "source": "live",
    }


_WARNINGS: list[str] = []


def _on_warning(w: Any) -> None:
    """Cost-budget warning sink: dedupe, remember, print once. Never raises."""
    try:
        msg = w.get("message") if isinstance(w, dict) else str(w)
        if not msg:
            return
        if msg not in _WARNINGS:
            _WARNINGS.append(msg)
            print(msg, file=sys.stderr)
    except Exception:
        pass


_METERED: Any = None


def _metered_wrapper() -> Any:
    """Lazily-built metered wrapper around _live_turn, reused across calls."""
    global _METERED
    if _METERED is not None:
        return _METERED
    cfg = load_app_config()
    opts = {
        "provider": PROVIDER_TAG,                     # "bedrock"
        "label": COST_LABEL,                          # "stayquiet-agent"
        "model_profile": "bedrock",                   # key in contracts/tokenizer-profiles.json
        "budget_config": {
            "global": {
                "budget": float(cfg["budget_tokens"]),
                "unit": "tokens",
                "threshold": float(cfg["budget_warn_at"]),
                "critical_threshold": 0.95,
                "label": "stayquiet-session",
            }
        },
        "usage_extractor": usage_extractor,
        "estimate_cost_per_1k_tokens": float(cfg["estimate_usd_per_1k"]),
        "on_warning": _on_warning,
    }
    _METERED = with_cost_guardrail(_live_turn, opts)
    return _METERED


def _normalize_cache_key(cache_key: str) -> str:
    """Map a human-readable cache key to the 64-char hex the golden cache needs.

    The pre-existing GoldenCache accepts ONLY 64-char lowercase hex keys: its
    `_resolve_key_location` warns and returns None for anything else, so `put`
    silently refuses and `get` always misses. A key that is already valid hex
    passes through; any other string is hashed with sha256 - the same derivation
    the cache's own explicit-key mode documents (`derive_key_standalone`:
    "Explicit-key mode hashes the caller kebab-case key once"). Callers therefore
    keep using readable keys everywhere. Never raises.
    """
    try:
        if len(cache_key) == 64 and all(c in "0123456789abcdef" for c in cache_key):
            return cache_key
        return hashlib.sha256(cache_key.encode("utf-8")).hexdigest()
    except Exception:
        return hashlib.sha256(repr(cache_key).encode("utf-8")).hexdigest()


_CACHE: Any = None


def _cache() -> Any:
    """Module-level golden cache rooted at AppConfig["golden_cache_dir"], created once."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    cfg = load_app_config()
    _CACHE = create_golden_cache(str(repo_root() / cfg["golden_cache_dir"]))
    return _CACHE


def run_agent(step_id: str, agent: Any, prompt: str, *, cache_key: str) -> LlmResult:
    """Invoke `agent` on `prompt` once, resiliently and metered. Never raises.

    Layering (outer to inner): with_resilience(timeout 45 s, 1 retry, exponential
    backoff, fallback chain cache → none, explicit cache key) wraps
    with_cost_guardrail(provider "bedrock", the AppConfig budget) which wraps the
    real `agent(prompt)` call. `step_id` is used only for log lines.

    Outcomes: a live turn returns source "live"; a golden-cache hit returns source
    "cache" with degraded True; exhaustion returns source "none", degraded True and
    text "" with `reason` set. AppConfig["demo_mode"] forces the cache path via the
    resilience kill switch, so the whole product runs offline unchanged.
    """
    try:
        cfg = load_app_config()
        config = {
            "timeout_ms": 45000,
            "retries": 1,
            "backoff": {"policy": "exponential", "base_ms": 600, "factor": 2.0,
                        "max_ms": 4000, "jitter": True},
            "fallback_chain": {"order": ["cache", "none"],
                               "cache": {"enabled": True}, "none": {"enabled": True}},
            "forced_degraded": bool(cfg["demo_mode"]),
        }
        deps = {"cache_key": _normalize_cache_key(cache_key), "cache": _cache()}
        guarded = with_resilience(_metered_wrapper(), config, deps)
        raw = guarded(agent, prompt)
        if is_degraded_result(raw):
            result: LlmResult = {
                "text": "",
                "degraded": True,
                "reason": raw.get("reason", "degraded") if isinstance(raw, dict) else "degraded",
                "input_tokens": None,
                "output_tokens": None,
                "source": "none",
            }
            print(f"[stayquiet] {step_id} source=none tokens=None/None", file=sys.stderr)
            return result
        if isinstance(raw, dict) and isinstance(raw.get("text"), str):
            source = raw.get("source") or "live"
            out: LlmResult = {
                "text": raw["text"],
                "degraded": source != "live",
                "reason": None if source == "live" else "served_from_golden_cache",
                "input_tokens": raw.get("input_tokens"),
                "output_tokens": raw.get("output_tokens"),
                "source": source,
            }
            print(f"[stayquiet] {step_id} source={source} "
                  f"tokens={out['input_tokens']}/{out['output_tokens']}", file=sys.stderr)
            return out
        fallback: LlmResult = {
            "text": "",
            "degraded": True,
            "reason": "unexpected_result_shape",
            "input_tokens": None,
            "output_tokens": None,
            "source": "none",
        }
        print(f"[stayquiet] {step_id} source=none tokens=None/None", file=sys.stderr)
        return fallback
    except Exception as err:  # noqa: BLE001 — run_agent never raises
        try:
            print(f"[stayquiet] {step_id} source=none tokens=None/None ({err})",
                  file=sys.stderr)
        except Exception:
            pass
        return {
            "text": "",
            "degraded": True,
            "reason": "run_agent_internal_error",
            "input_tokens": None,
            "output_tokens": None,
            "source": "none",
        }


def cost_snapshot() -> dict:
    """Current usage totals for the UI and the run report.

    Returns {"total_tokens": int, "request_count": int,
             "estimated_cost_usd": float | None, "budget_tokens": int,
             "utilization": float, "warnings": list[str]}.
    `estimated_cost_usd` is a MODELLED figure from AppConfig["estimate_usd_per_1k"],
    never a bill. Never raises; on any internal error returns zeros with a warning.
    """
    try:
        store = get_default_store()
        cfg = load_app_config()
        t = store.global_totals()
        budget = int(cfg["budget_tokens"])
        utilization = round(t["total_tokens"] / budget, 4) if budget else 0.0
        return {
            "total_tokens": t["total_tokens"],
            "request_count": t["request_count"],
            "estimated_cost_usd": t["estimated_cost_usd"],
            "budget_tokens": budget,
            "utilization": utilization,
            "warnings": list(_WARNINGS),
        }
    except Exception:
        return {
            "total_tokens": 0,
            "request_count": 0,
            "estimated_cost_usd": None,
            "budget_tokens": 0,
            "utilization": 0.0,
            "warnings": ["cost snapshot unavailable"],
        }


def record_golden(cache_key: str, text: str) -> None:
    """Write one model reply into the committed golden cache under `cache_key`, in
    the exact shape run_agent()'s cache path expects. Used by the recording script
    so the offline demo path has real content. Never raises.

    `cache_key` is the readable name; it is normalized for the filename and also
    stored verbatim in the entry's `explicit_key` metadata field, which is what
    keeps the cache's `golden-index.json` manifest human-readable.
    """
    try:
        normalized = _normalize_cache_key(cache_key)
        meta: dict[str, Any] = {"provider": PROVIDER_TAG,
                                "model": load_app_config()["model_id"],
                                "source": "recorded"}
        if normalized != cache_key:
            meta["explicit_key"] = cache_key
        _cache().put(
            normalized,
            {"text": text, "input_tokens": None, "output_tokens": None, "source": "cache"},
            meta,
        )
    except Exception as err:  # noqa: BLE001 — recording must never crash the app
        try:
            print(f"[stayquiet] could not record {cache_key}: {err}", file=sys.stderr)
        except Exception:
            pass


def golden_keys() -> list[str]:
    """Sorted list of the cache keys currently present in the golden cache. Used by
    the recording script to report coverage. Never raises.

    Reports the readable name recorded in each manifest entry's `explicit_key`
    field when one exists, and the hex filename otherwise - so a caller sees
    `draft::BK-1044::2026-09-08`, not a sha256 digest.
    """
    try:
        names: set[str] = set()
        known_hex: set[str] = set()
        try:
            cfg = load_app_config()
            manifest = repo_root() / cfg["golden_cache_dir"] / "golden-index.json"
            entries = json.loads(manifest.read_text(encoding="utf-8")).get("entries", {})
            if isinstance(entries, dict):
                for hex_key, entry in entries.items():
                    known_hex.add(hex_key)
                    if isinstance(entry, dict) and isinstance(entry.get("explicit_key"), str):
                        names.add(entry["explicit_key"])
                    else:
                        names.add(hex_key)
        except Exception:
            pass
        try:
            for hex_key in _cache().list().keys():
                # list() only knows hex; keep it unless the manifest already
                # reported this entry under a human-readable name.
                if hex_key not in known_hex:
                    names.add(hex_key)
        except Exception:
            pass
        return sorted(names)
    except Exception:
        return []
