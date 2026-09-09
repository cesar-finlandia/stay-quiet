# StayQuiet — the ONE configuration surface (blueprint §2.5, contract rows 1-2).
# Every other module calls load_app_config(); no other file opens
# config/stayquiet.json and no other file hardcodes a value that lives in it.
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional, TypedDict

APP_CONFIG_PATH: str = "config/stayquiet.json"


class AppConfig(TypedDict):
    """Fully-resolved application configuration. Every key is always present."""

    model_id: str
    region: str
    demo_mode: bool
    cycle_interval_s: int
    fixtures_dir: str
    golden_cache_dir: str
    max_bookings: int
    thread_token_budget: int
    budget_tokens: int
    budget_warn_at: float
    estimate_usd_per_1k: float
    escalate_refund_over_eur: float


DEFAULTS: AppConfig = {
    "model_id": "global.anthropic.claude-sonnet-4-6",
    "region": "us-west-2",
    "demo_mode": False,
    "cycle_interval_s": 900,
    "fixtures_dir": "fixtures/synthetic",
    "golden_cache_dir": "fixtures/golden",
    "max_bookings": 6,
    "thread_token_budget": 900,
    "budget_tokens": 400000,
    "budget_warn_at": 0.8,
    "estimate_usd_per_1k": 0.006,
    "escalate_refund_over_eur": 0.0,
}

_cached: Optional[AppConfig] = None


def repo_root() -> Path:
    """Absolute path of the repository root (the parent of src/)."""
    return Path(__file__).resolve().parents[2]


def _as_bool(raw: str) -> bool:
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _apply_env(cfg: AppConfig) -> AppConfig:
    """Env overrides listed in blueprint §2.5. Malformed values are ignored."""
    if os.environ.get("STAYQUIET_MODEL_ID"):
        cfg["model_id"] = os.environ["STAYQUIET_MODEL_ID"]
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if region:
        cfg["region"] = region
    if os.environ.get("STAYQUIET_DEMO_MODE") is not None:
        cfg["demo_mode"] = _as_bool(os.environ["STAYQUIET_DEMO_MODE"])
    if os.environ.get("STAYQUIET_CYCLE_INTERVAL_S"):
        try:
            cfg["cycle_interval_s"] = max(5, int(os.environ["STAYQUIET_CYCLE_INTERVAL_S"]))
        except ValueError:
            print("[stayquiet] STAYQUIET_CYCLE_INTERVAL_S is not an integer; keeping default",
                  file=sys.stderr)
    if os.environ.get("GOLDEN_CACHE_DIR"):
        cfg["golden_cache_dir"] = os.environ["GOLDEN_CACHE_DIR"]
    return cfg


def load_app_config(path: str | None = None) -> AppConfig:
    """Read config/stayquiet.json, apply env overrides, return a complete AppConfig.

    Never raises: a missing, unreadable or malformed file prints one warning to
    stderr and returns DEFAULTS. Unknown keys in the file are ignored. Result is
    cached after the first call; pass an explicit path to bypass the cache.
    """
    global _cached
    if path is None and _cached is not None:
        return _cached
    cfg: AppConfig = dict(DEFAULTS)  # type: ignore[assignment]
    target = Path(path) if path else (repo_root() / APP_CONFIG_PATH)
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("root is not a JSON object")
        for key in DEFAULTS:
            if key in raw and isinstance(raw[key], type(DEFAULTS[key])):  # type: ignore[literal-required]
                cfg[key] = raw[key]  # type: ignore[literal-required]
    except FileNotFoundError:
        print(f"[stayquiet] {target} not found; using built-in defaults", file=sys.stderr)
    except Exception as err:  # noqa: BLE001 — configuration must never crash the app
        print(f"[stayquiet] {target} unreadable ({err}); using built-in defaults", file=sys.stderr)
    cfg = _apply_env(cfg)
    # Environment always wins for the cache dir the resilience layer reads.
    os.environ.setdefault("GOLDEN_CACHE_DIR", str(repo_root() / cfg["golden_cache_dir"]))
    if path is None:
        _cached = cfg
    return cfg
