# StayQuiet tools — the audit logger (deterministic, no model call).
from __future__ import annotations

from strands import tool

from engine.tools.ctx import current_trace, tool_begin, tool_end
from src.stayquiet.audit import audit_append


@tool
def audit_log(action: str, booking_id: str, detail: str) -> dict:
    """Record what you just did, so a dispute can be defended later.

    Call this after every action you take on a booking: a draft prepared, a
    checklist built, a policy change noticed, or a decision handed to the host.
    `action` is a short verb phrase in snake_case, `detail` is one plain sentence a
    person can read months later. Pass an empty string for `booking_id` when the
    action is not about one booking.

    Returns: {"entry_id": str, "at": str, "action": str, "booking_id": str}
    """
    tool_begin("audit_write", {"action": action, "booking_id": booking_id})
    try:
        entry = audit_append(str(action), str(booking_id or ""), str(detail),
                             trace_id=current_trace())
        tool_end("audit_write", {"entry_id": entry["entry_id"], "action": entry["action"],
                                 "booking_id": entry["booking_id"]})
        return {"entry_id": entry["entry_id"], "at": entry["at"],
                "action": entry["action"], "booking_id": entry["booking_id"]}
    except Exception as err:
        tool_end("audit_write", {"error": str(err)[:400]}, degraded=True)
        return {"entry_id": "", "at": "", "action": str(action),
                "booking_id": str(booking_id or "")}
