# StayQuiet — the ONLY place an EventEnvelope is created or published
# (blueprint §2.4 rows 18-22, §2.4c rule 1).
#
# The envelope shape is frozen by contracts/event-envelope.schema.json and typed by
# src/platform/transport/event_envelope.py; it is never redefined here. `sequence`
# is assigned only inside emit(), under a lock, so it is globally monotonic.
#
# Delivery model: emit() appends to an in-process ring buffer. The SSE route polls
# since() — there is no queue and no async call, so the synchronous agent loop can
# emit from any thread without an event loop in sight.
from __future__ import annotations

import json
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.platform.transport.event_envelope import EventEnvelope

#: Largest number of envelopes kept in memory. Older ones are dropped from the
#: front; a demo cycle emits roughly 30.
RING_CAPACITY: int = 2000

#: The closed step_id vocabulary (blueprint §2.3). emit() warns on anything else.
#: Underscored on purpose: these ids are also the Python tool names the agent loop
#: calls, so one vocabulary serves the tool, its progress envelope and its UI label.
#: contracts/event-envelope.schema.json v1.1.0 accepts them (see DP-STREAM §0).
STEP_IDS: tuple[str, ...] = (
    "cycle",
    "policy_fetch",
    "policy_diff",
    "booking_scan",
    "booking_lookup",
    "clause_lookup",
    "checklist_baseline",
    "draft_reply",
    "turnover_checklist",
    "triage",
    "audit_write",
    "decision_resolved",
)

#: The four allowed status values, frozen by the envelope schema.
STATUSES: tuple[str, ...] = ("started", "streaming", "done", "error")

_lock = threading.Lock()
_ring: list[dict] = []
_seq = 0


def new_trace_id() -> str:
    """A fresh trace id for one cycle or one API action (uuid4 as a string)."""
    return str(uuid.uuid4())


def emit(
    step_id: str,
    status: str,
    payload: dict,
    *,
    trace_id: str,
    degraded: bool = False,
) -> dict:
    """Create, record and publish one EventEnvelope. Returns the envelope.

    `sequence` is assigned here and nowhere else. An unknown `step_id` or `status`
    is still published (never dropped) but prints one stderr warning naming the
    closed vocabulary, so a typo is loud instead of invisible. `payload` must be
    JSON-serializable; a value that is not is replaced by
    {"unserializable": "<repr>"} rather than raising. Never raises.
    """
    global _seq
    try:
        if step_id not in STEP_IDS:
            print(f"[stayquiet] unknown step_id \"{step_id}\" — the vocabulary is: "
                  f"{', '.join(STEP_IDS)}", file=sys.stderr)
        if status not in STATUSES:
            print(f"[stayquiet] unknown status \"{status}\" — the allowed values are: "
                  f"{', '.join(STATUSES)}", file=sys.stderr)
            status = "streaming"
        try:
            json.dumps(payload)
            if isinstance(payload, dict):
                safe_payload = payload
            else:
                safe_payload = {"value": payload}
        except (TypeError, ValueError):
            safe_payload = {"unserializable": repr(payload)[:500]}
        with _lock:
            _seq += 1
            env: dict = {
                "step_id": str(step_id),
                "status": status,
                "payload": safe_payload,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "sequence": _seq,
                "trace_id": str(trace_id),
                "degraded": bool(degraded),
            }
            _ring.append(env)
            while len(_ring) > RING_CAPACITY:
                _ring.pop(0)
            return dict(env)
    except Exception as err:  # noqa: BLE001 — a broken emit must never stop a cycle
        try:
            print(f"[stayquiet] emit failed ({err})", file=sys.stderr)
        except Exception:
            pass
        return {
            "step_id": str(step_id) if isinstance(step_id, str) else "cycle",
            "status": "error",
            "payload": {"emit_error": str(err)},
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sequence": 0,
            "trace_id": str(trace_id) if isinstance(trace_id, str) else "",
            "degraded": True,
        }


def envelopes(trace_id: str | None = None) -> list[dict]:
    """Every envelope currently in the ring, sequence-sorted. Filtered to one
    trace when `trace_id` is given. Returns a copy — callers may mutate it."""
    with _lock:
        items = list(_ring)
    if trace_id is not None:
        items = [e for e in items if e.get("trace_id") == trace_id]
    return sorted(items, key=lambda e: e["sequence"])


def since(sequence: int, trace_id: str | None = None) -> list[dict]:
    """Every envelope whose `sequence` is greater than `sequence`, sequence-sorted.

    This is the SSE route's only read path (DP-API polls it). Filtered to one trace
    when `trace_id` is given. Returns a copy.
    """
    with _lock:
        items = [e for e in _ring if e.get("sequence", 0) > sequence]
    if trace_id is not None:
        items = [e for e in items if e.get("trace_id") == trace_id]
    return sorted(items, key=lambda e: e["sequence"])


def snapshot(trace_id: str | None = None) -> dict:
    """The GET /events fallback body (blueprint §2.3).

    Returns {"status": "complete", "trace_id": str, "events": list[dict],
             "degraded": bool} where `degraded` is True if any included envelope
    has degraded True. `trace_id` defaults to the newest envelope's trace, or "" if
    the ring is empty.
    """
    items = envelopes(trace_id)
    if trace_id is None:
        tid = items[-1]["trace_id"] if items else ""
    else:
        tid = trace_id
    return {
        "status": "complete",
        "trace_id": tid,
        "events": items,
        "degraded": any(e.get("degraded") is True for e in items),
    }


def latest_sequence() -> int:
    """The highest sequence assigned so far; 0 before the first emit."""
    with _lock:
        return _seq


def reset() -> None:
    """Clear the ring and reset the sequence to 0. Tests and the recording script
    only — the API never calls it."""
    global _seq
    with _lock:
        _ring.clear()
        _seq = 0
