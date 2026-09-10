# StayQuiet tools — turnover-checklist grounding (deterministic, no model call).
from __future__ import annotations

from strands import tool

from engine.tools.ctx import tool_begin, tool_end, tool_error
from src.stayquiet.seed import PolicyClause, find_booking, load_snapshots

#: Task ids and the phrases that identify them in policy text. Extending this list
#: is the only supported way to add a task — no free-text parsing beyond it.
TASK_VOCAB: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("strip_bed_linen", ("strip bed linen", "strip the bed linen", "stripping the bed linen", "strip bed")),
    ("launder_textiles", ("launder textiles", "launder", "laundry", "laundering")),
    ("run_dishwasher", ("run the dishwasher", "running the dishwasher", "dishwasher")),
    ("take_out_refuse", ("take out refuse", "taking out refuse", "refuse", "rubbish")),
    ("return_furniture", ("return furniture", "returning furniture", "furniture")),
)

#: Phrases that make a sentence a prohibition rather than a permission.
FORBID_MARKERS: tuple[str, ...] = (
    "may no longer require",
    "may not require",
    "must not require",
    "may not charge",
    "no longer require",
)

#: The clause the turnover checklist is derived from.
CHECKOUT_CLAUSE_ID: str = "cleaning.checkout_tasks"


@tool
def checklist_baseline(booking_id: str) -> dict:
    """Get the checkout tasks a host may and may not require for one booking.

    Use this before writing a turnover checklist, so the checklist never asks for
    something the current policy forbids. `forbidden_tasks` must never appear in a
    checklist you write.

    Returns: {"booking_id": str, "clause_id": str,
              "permitted_tasks": list[str], "forbidden_tasks": list[str],
              "cleaner_note": str|None, "prior_disputes": int,
              "clause_text": str}
    On an unknown booking id returns {"error": "unknown booking_id",
    "booking_id": str}.
    """
    tool_begin("checklist_baseline", {"booking_id": booking_id})
    try:
        b = find_booking(str(booking_id).strip())
        if b is None:
            tool_end("checklist_baseline", {"booking_id": booking_id, "found": False},
                     degraded=True)
            return {"error": "unknown booking_id", "booking_id": booking_id}
        snaps = load_snapshots()
        if not snaps:
            tool_end("checklist_baseline", {"booking_id": b["booking_id"], "found": False},
                     degraded=True)
            return {"error": "no policy snapshots available", "booking_id": b["booking_id"]}
        clause = next((c for c in snaps[-1]["clauses"]
                       if c["clause_id"] == CHECKOUT_CLAUSE_ID), None)
        permitted: list[str] = []
        forbidden: list[str] = []
        degraded = False
        if clause is None:
            text = ""
            degraded = True
        else:
            text = clause["text"]
            low = text.lower()
            sentences = [s.strip() for s in low.replace("\n", " ").split(".") if s.strip()]
            for task_id, phrases in TASK_VOCAB:
                hits = [s for s in sentences if any(p in s for p in phrases)]
                if not hits:
                    continue
                if any(m in s for s in hits for m in FORBID_MARKERS):
                    forbidden.append(task_id)
                else:
                    permitted.append(task_id)
        result = {"booking_id": b["booking_id"], "clause_id": CHECKOUT_CLAUSE_ID,
                  "permitted_tasks": permitted, "forbidden_tasks": forbidden,
                  "cleaner_note": b["cleaner_notes"], "prior_disputes": b["prior_disputes"],
                  "clause_text": text}
        tool_end("checklist_baseline", {"booking_id": b["booking_id"],
                                        "permitted": permitted, "forbidden": forbidden},
                 degraded=degraded)
        return result
    except Exception as err:
        tool_error("checklist_baseline", str(err))
        return {"error": str(err), "booking_id": booking_id}
