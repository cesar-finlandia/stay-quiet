# StayQuiet tools — booking context lookup (deterministic, no model call).
from __future__ import annotations

from strands import tool

from engine.tools.ctx import tool_begin, tool_end, tool_error
from src.stayquiet.config import load_app_config
from src.stayquiet.context_bridge import fit_thread
from src.stayquiet.seed import find_booking, thread_messages


@tool
def booking_lookup(booking_id: str) -> dict:
    """Get one booking's facts and its recent guest and cleaner messages.

    Use this before drafting anything, so the reply is grounded in that booking's
    real dates, payout and message history. The message thread is trimmed to a
    token budget, keeping the newest messages; `thread_dropped` says how many older
    messages were left out.

    Returns: {"booking_id": str, "guest_name": str, "listing_name": str,
              "check_in": str, "check_out": str, "nights": int, "payout_eur": float,
              "status": str, "policy_refs": list[str], "prior_disputes": int,
              "open_issue": str|None, "cleaner_notes": str|None,
              "thread": [{"role": str, "content": str}], "thread_dropped": int,
              "thread_tokens": int, "thread_degraded": bool}
    On an unknown id returns {"error": "unknown booking_id", "booking_id": str}.
    """
    tool_begin("booking_lookup", {"booking_id": booking_id})
    try:
        b = find_booking(str(booking_id).strip())
        if b is None:
            tool_end("booking_lookup", {"booking_id": booking_id, "found": False},
                     degraded=True)
            return {"error": "unknown booking_id", "booking_id": booking_id}
        cfg = load_app_config()
        fitted = fit_thread(thread_messages(b), cfg["thread_token_budget"])
        result = {
            "booking_id": b["booking_id"],
            "guest_name": b["guest_name"],
            "listing_name": b["listing_name"],
            "check_in": b["check_in"],
            "check_out": b["check_out"],
            "nights": b["nights"],
            "payout_eur": b["payout_eur"],
            "status": b["status"],
            "policy_refs": list(b["policy_refs"]),
            "prior_disputes": b["prior_disputes"],
            "open_issue": b["open_issue"],
            "cleaner_notes": b["cleaner_notes"],
            "thread": fitted["messages"],
            "thread_dropped": fitted["dropped"],
            "thread_tokens": fitted["tokens"],
            "thread_degraded": fitted["degraded"],
        }
        tool_end("booking_lookup",
                 {"booking_id": b["booking_id"], "guest_name": b["guest_name"],
                  "listing_name": b["listing_name"],
                  "thread_kept": len(fitted["messages"]),
                  "thread_dropped": fitted["dropped"],
                  "thread_tokens": fitted["tokens"]},
                 degraded=fitted["degraded"])
        return result
    except Exception as err:
        tool_error("booking_lookup", str(err))
        return {"error": str(err), "booking_id": booking_id}
