# StayQuiet tools — the policy watcher's two tools (deterministic, no model call).
from __future__ import annotations

from strands import tool

from engine.tools.ctx import tool_begin, tool_end, tool_error
from src.stayquiet.seed import diff_snapshots, load_snapshots


@tool
def policy_fetch(as_of: str = "latest") -> dict:
    """Load one snapshot of the platform's public policy text.

    Use this to find out which policy capture you are working against. Pass
    "latest" for the newest capture, "previous" for the one before it, or a capture
    date in YYYY-MM-DD form.

    Returns: {"captured_at": str, "source": str, "clause_count": int,
              "clause_ids": list[str], "available": list[str]}
    On failure returns {"error": str, "available": list[str]}.
    """
    tool_begin("policy_fetch", {"as_of": as_of})
    try:
        snaps = load_snapshots()
        available = [s["captured_at"] for s in snaps]
        if not snaps:
            tool_end("policy_fetch", {"clause_count": 0}, degraded=True)
            return {"error": "no policy snapshots available", "available": []}
        if as_of == "latest" or not as_of:
            chosen = snaps[-1]
            result = {
                "captured_at": chosen["captured_at"],
                "source": chosen["source"],
                "clause_count": len(chosen["clauses"]),
                "clause_ids": [c["clause_id"] for c in chosen["clauses"]],
                "available": available,
            }
        elif as_of == "previous":
            chosen = snaps[-2] if len(snaps) >= 2 else snaps[0]
            result = {
                "captured_at": chosen["captured_at"],
                "source": chosen["source"],
                "clause_count": len(chosen["clauses"]),
                "clause_ids": [c["clause_id"] for c in chosen["clauses"]],
                "available": available,
            }
        else:
            wanted = str(as_of).strip()
            chosen = next((s for s in snaps if s["captured_at"] == wanted), None)
            if chosen is None:
                chosen = snaps[-1]
                result = {
                    "captured_at": chosen["captured_at"],
                    "source": chosen["source"],
                    "clause_count": len(chosen["clauses"]),
                    "clause_ids": [c["clause_id"] for c in chosen["clauses"]],
                    "available": available,
                    "requested_not_found": as_of,
                }
            else:
                result = {
                    "captured_at": chosen["captured_at"],
                    "source": chosen["source"],
                    "clause_count": len(chosen["clauses"]),
                    "clause_ids": [c["clause_id"] for c in chosen["clauses"]],
                    "available": available,
                }
        tool_end("policy_fetch", {"captured_at": chosen["captured_at"],
                                  "clause_count": len(chosen["clauses"])})
        return result
    except Exception as err:
        tool_error("policy_fetch", str(err))
        return {"error": str(err), "available": []}


@tool
def policy_diff() -> dict:
    """List every clause that changed between the two most recent policy captures.

    Use this first: it tells you what changed, whether the change is about money,
    and which clause ids to look up. It does not include the clause text — call
    clause_lookup for that.

    Returns: {"previous_captured_at": str, "latest_captured_at": str,
              "changed_count": int,
              "changes": [{"clause_id": str, "title": str,
                           "change_kind": "added"|"removed"|"modified",
                           "money_related": bool}]}
    On failure returns {"error": str, "changed_count": 0, "changes": []}.
    """
    tool_begin("policy_diff", {})
    try:
        snaps = load_snapshots()
        if len(snaps) < 2:
            tool_end("policy_diff", {"changed_count": 0}, degraded=True)
            return {"error": "need two snapshots to diff", "changed_count": 0, "changes": []}
        changes = diff_snapshots(snaps[-2], snaps[-1])
        slim = [{"clause_id": c["clause_id"], "title": c["title"],
                 "change_kind": c["change_kind"], "money_related": c["money_related"]}
                for c in changes]
        result = {"previous_captured_at": snaps[-2]["captured_at"],
                  "latest_captured_at": snaps[-1]["captured_at"],
                  "changed_count": len(slim),
                  "changes": slim}
        tool_end("policy_diff", {"changed_count": len(slim),
                                 "clause_ids": [c["clause_id"] for c in slim],
                                 "money_related": [c["clause_id"] for c in slim
                                                   if c["money_related"]]})
        return result
    except Exception as err:
        tool_error("policy_diff", str(err))
        return {"error": str(err), "changed_count": 0, "changes": []}
