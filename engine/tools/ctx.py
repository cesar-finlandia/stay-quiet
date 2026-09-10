# StayQuiet tools — shared per-cycle context (blueprint §2.4 row 29).
# Holds the current trace id so a tool can tag its envelope without the model
# having to pass one, and records which tools the loop actually chose so the agent
# can report real tool usage. Module-level state: this process runs one cycle at a
# time by design (DP-API serialises cycles).
from __future__ import annotations

import threading
from typing import Any

from src.stayquiet.publish import emit

_lock = threading.Lock()
_trace: str = ""
_calls: list[str] = []


def set_trace(trace_id: str) -> None:
    """Set the trace id every subsequent tool envelope is tagged with. Called once
    per cycle by the agent, before the loop starts."""
    global _trace
    with _lock:
        _trace = str(trace_id)
        _calls.clear()


def current_trace() -> str:
    """The active trace id, or "" when set_trace has not been called."""
    with _lock:
        return _trace


def note_tool_call(name: str) -> None:
    """Record that the loop invoked the tool called `name`. Appended in call order,
    duplicates kept."""
    with _lock:
        _calls.append(str(name))


def drain_tool_calls() -> list[str]:
    """Return the recorded tool-call names in order and clear the recorder. The
    agent calls this after each turn so its CycleResult reports genuine tool use."""
    with _lock:
        out = list(_calls)
        _calls.clear()
        return out


def tool_begin(step_id: str, payload: dict) -> None:
    """Record the call and emit `{step_id}` with status "started". Never raises."""
    try:
        note_tool_call(step_id)
        emit(step_id, "started", payload, trace_id=current_trace())
    except Exception:
        pass


def tool_end(step_id: str, payload: dict, degraded: bool = False) -> None:
    """Emit `{step_id}` with status "done". Never raises."""
    try:
        emit(step_id, "done", payload, trace_id=current_trace(), degraded=degraded)
    except Exception:
        pass


def tool_error(step_id: str, message: str) -> None:
    """Emit `{step_id}` with status "error" and degraded True. Never raises."""
    try:
        emit(step_id, "error", {"error": str(message)[:400]},
             trace_id=current_trace(), degraded=True)
    except Exception:
        pass
