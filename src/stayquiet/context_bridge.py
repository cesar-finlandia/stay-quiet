# StayQuiet — the Python side of the context buffer (blueprint §2.4 rows 16-17).
# The buffer itself is the pre-existing TypeScript module src/context; this file
# calls it through engine/bridge/context_fit.ts in a short-lived Node process and
# degrades to a deterministic newest-first trim when Node is unavailable.
from __future__ import annotations

import json
import subprocess
import sys
from typing import TypedDict

from src.stayquiet.config import repo_root

#: Seconds to wait for the Node bridge before falling back.
BRIDGE_TIMEOUT_S: float = 20.0


class ThreadFit(TypedDict):
    """Result of fitting a message thread to a token budget."""

    messages: list[dict]  # the kept messages, oldest first, same shape as input
    dropped: int          # how many messages were evicted
    tokens: int           # token count of the kept messages
    degraded: bool        # True when the fallback trim was used instead of the buffer


def fit_thread(messages: list[dict], max_tokens: int) -> ThreadFit:
    """Fit a [{role, content}] thread into `max_tokens`, keeping the newest.

    Calls the context buffer through the Node bridge. If Node is missing, the
    bridge fails, or it does not answer within BRIDGE_TIMEOUT_S, falls back to
    _fallback_trim() and returns degraded True. Never raises.
    """
    try:
        if not messages:
            return {"messages": [], "dropped": 0, "tokens": 0, "degraded": False}
        root = repo_root()
        bundled = root / "dist" / "bridge" / "context_fit.mjs"
        if bundled.exists():
            cmd = ["node", "dist/bridge/context_fit.mjs"]
        else:
            cmd = ["npx", "--yes", "vite-node", "engine/bridge/context_fit.ts"]
        try:
            proc = subprocess.run(
                cmd,
                input=json.dumps({"messages": messages, "maxTokens": max_tokens}),
                capture_output=True,
                text=True,
                timeout=BRIDGE_TIMEOUT_S,
                cwd=str(root),
                shell=(sys.platform == "win32"),
            )
        except FileNotFoundError as err:
            print(f"[stayquiet] context bridge unavailable ({err}); using degraded trim",
                  file=sys.stderr)
            return _fallback_trim(messages, max_tokens)
        except subprocess.TimeoutExpired as err:
            print(f"[stayquiet] context bridge unavailable ({err}); using degraded trim",
                  file=sys.stderr)
            return _fallback_trim(messages, max_tokens)
        if proc.returncode != 0:
            print(f"[stayquiet] context bridge unavailable "
                  f"(exit {proc.returncode}); using degraded trim", file=sys.stderr)
            return _fallback_trim(messages, max_tokens)
        try:
            out = json.loads(proc.stdout or "{}")
        except Exception as err:
            print(f"[stayquiet] context bridge unavailable ({err}); using degraded trim",
                  file=sys.stderr)
            return _fallback_trim(messages, max_tokens)
        if (not isinstance(out, dict) or not isinstance(out.get("messages"), list)
                or not isinstance(out.get("dropped"), int)
                or not isinstance(out.get("tokens"), int)):
            print("[stayquiet] context bridge unavailable (malformed reply); "
                  "using degraded trim", file=sys.stderr)
            return _fallback_trim(messages, max_tokens)
        return {
            "messages": out["messages"],
            "dropped": out["dropped"],
            "tokens": out["tokens"],
            "degraded": False,
        }
    except Exception as err:  # noqa: BLE001 — fit_thread never raises
        try:
            print(f"[stayquiet] context bridge unavailable ({err}); using degraded trim",
                  file=sys.stderr)
        except Exception:
            pass
        try:
            return _fallback_trim(messages, max_tokens)
        except Exception:
            return {"messages": [], "dropped": len(messages or []), "tokens": 0, "degraded": True}


def _fallback_trim(messages: list[dict], max_tokens: int) -> ThreadFit:
    """Deterministic degraded path: keep newest messages while the running
    chars/4 estimate stays within `max_tokens`; always keep at least the last
    message. Returns degraded True."""
    kept: list[dict] = []
    used = 0
    for m in reversed(messages):
        cost = max(1, len(m.get("content") or "") // 4)
        if not kept:
            kept.append(m)
            used += cost
            continue
        if used + cost > max_tokens:
            break
        kept.append(m)
        used += cost
    kept.reverse()
    return {
        "messages": kept,
        "dropped": len(messages) - len(kept),
        "tokens": used,
        "degraded": True,
    }
