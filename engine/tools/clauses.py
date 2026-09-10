# StayQuiet tools — clause grounding lookup (deterministic, no model call).
from __future__ import annotations

from strands import tool

from engine.tools.ctx import tool_begin, tool_end, tool_error
from src.stayquiet.seed import diff_snapshots, load_snapshots


@tool
def clause_lookup(clause_id: str) -> dict:
    """Get the CURRENT text of one policy clause, plus what it used to say.

    Use this to quote or paraphrase policy accurately. Never state a policy rule
    that is not in `current_text`.

    Returns: {"clause_id": str, "title": str, "current_text": str,
              "previous_text": str|None, "change_kind": str|None,
              "money_related": bool}
    On an unknown id returns {"error": "unknown clause_id", "clause_id": str,
    "available": list[str]}.
    """
    tool_begin("clause_lookup", {"clause_id": clause_id})
    try:
        snaps = load_snapshots()
        if not snaps:
            tool_end("clause_lookup", {"clause_id": clause_id, "found": False},
                     degraded=True)
            return {"error": "no policy snapshots available", "clause_id": clause_id,
                    "available": []}
        cid = str(clause_id).strip()
        latest = snaps[-1]
        available = [c["clause_id"] for c in latest["clauses"]]
        current = next((c for c in latest["clauses"] if c["clause_id"] == cid), None)
        changes = diff_snapshots(snaps[-2], snaps[-1]) if len(snaps) >= 2 else []
        change = next((c for c in changes if c["clause_id"] == cid), None)
        if current is None and change is None:
            tool_end("clause_lookup", {"clause_id": cid, "found": False}, degraded=True)
            return {"error": "unknown clause_id", "clause_id": cid, "available": available}
        result = {"clause_id": cid,
                  "title": (current or change)["title"],
                  "current_text": current["text"] if current else None,
                  "previous_text": change["previous_text"] if change else None,
                  "change_kind": change["change_kind"] if change else None,
                  "money_related": bool(change["money_related"]) if change else False}
        tool_end("clause_lookup",
                 {"clause_id": cid, "change_kind": result["change_kind"],
                  "money_related": result["money_related"],
                  "chars": len(result["current_text"] or ""),
                  "citations": [{"title": f"{result['title']} ({cid})",
                                 "snippet": (result["current_text"] or "")[:220]}]})
        return result
    except Exception as err:
        tool_error("clause_lookup", str(err))
        return {"error": str(err), "clause_id": clause_id, "available": []}
