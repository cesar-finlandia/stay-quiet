# StayQuiet — the Strands agent loop and the one deterministic cycle around it
# (blueprint §2.4 rows 30-31).
#
# The division of labour, which is the whole design:
#   * Deterministic Python decides WHICH bookings need work and WHETHER the host is
#     asked. Those are scheduling and policy decisions; a model must not be the
#     reason a refund is or is not escalated.
#   * The Strands agent loop, on an Amazon Bedrock model, decides HOW to say it: it
#     chooses which tools to call for grounding and writes the guest reply and the
#     turnover checklist.
#
# Exactly two model turns run per affected booking. Everything else is pure Python.
from __future__ import annotations

import re
import sys
import time
from pathlib import Path
from typing import Optional, TypedDict

from engine.tools import ALL_TOOLS, drain_tool_calls, set_trace
from engine.tools.auditing import audit_log
from engine.tools.policy import policy_diff, policy_fetch
from src.stayquiet.audit import audit_append
from src.stayquiet.config import load_app_config, repo_root
from src.stayquiet.model import build_agent, cost_snapshot, run_agent
from src.stayquiet.publish import emit, new_trace_id
from src.stayquiet.seed import affected_bookings, diff_snapshots, load_bookings, load_snapshots
from src.stayquiet.store import add_decision, create_run, finish_run

#: Matches a specific money amount in drafted text. A quiet action whose draft names
#: an amount is escalated instead (§5.5 rule 5) — StayQuiet never files a number
#: without the host seeing it.
MONEY_RE = re.compile(
    r"(?:€|eur\s?)\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|eur|euro|euros)", re.IGNORECASE
)

#: Clause-id prefixes that force an escalation, and the decision kind each produces.
ESCALATING_PREFIXES: tuple[tuple[str, str], ...] = (
    ("payments.", "exception"),
    ("cancellation.", "refund"),
)

#: A booking with at least this many prior disputes is escalated as a review risk.
REVIEW_RISK_DISPUTES: int = 2

#: Hard cap on checklist lines kept from the model's answer.
MAX_CHECKLIST_ITEMS: int = 8


class CycleParams(TypedDict, total=False):
    """Everything a caller may vary about one cycle. All keys optional."""

    trace_id: str          # reuse an existing trace instead of minting one
    max_bookings: int      # override AppConfig["max_bookings"]
    booking_filter: str    # process only this booking_id (used by the recorder)


class CycleResult(TypedDict):
    """The complete outcome of one cycle. Returned even when everything degraded."""

    trace_id: str
    run_id: str
    previous_captured_at: str
    latest_captured_at: str
    changed_clauses: list[str]
    money_clauses: list[str]
    bookings_scanned: int
    bookings_affected: int
    drafts: list[dict]      # [{booking_id, text, degraded, source}]
    checklists: list[dict]  # [{booking_id, items, degraded, source}]
    decisions: list[dict]   # the Decision records raised by this cycle
    quiet_actions: int
    tool_calls: list[str]   # the tools the Strands loop chose, in call order
    degraded: bool
    elapsed_ms: int
    tokens: int
    cost: dict              # cost_snapshot() at the end of the cycle
    summary: str            # one sentence for the UI and the audit trail


def load_prompt(name: str) -> str:
    """Read engine/prompts/<name>. Returns "" plus one stderr warning when the file
    is missing, so a lost prompt degrades the wording rather than the run."""
    try:
        return (repo_root() / "engine" / "prompts" / name).read_text(encoding="utf-8")
    except Exception as err:
        try:
            print(f"[stayquiet] prompt {name} unreadable ({err}); using empty prompt",
                  file=sys.stderr)
        except Exception:
            pass
        return ""


_warned_placeholders: set[str] = set()


def render(template: str, values: dict) -> str:
    """Replace every {{key}} in `template` with str(values[key]).

    Unknown placeholders are left as they are and warned about once; a missing value
    renders as the empty string. No other templating syntax is supported — this is
    deliberately not a template engine.
    """
    try:
        def _sub(match: re.Match) -> str:
            key = match.group(1)
            if key in values:
                v = values[key]
                return "" if v is None else str(v)
            if key not in _warned_placeholders:
                _warned_placeholders.add(key)
                try:
                    print(f"[stayquiet] unknown placeholder {{{{{key}}}}} left as-is",
                          file=sys.stderr)
                except Exception:
                    pass
            return match.group(0)

        return re.sub(r"\{\{(\w+)\}\}", _sub, template)
    except Exception:
        return template


def parse_checklist(text: str) -> list[str]:
    """Turn the model's checklist answer into a clean list of task lines (§5.4)."""
    try:
        if not text:
            return []
        items: list[str] = []
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith(("- ", "* ", "• ")):
                s = s[2:]
            elif re.match(r"^\d+[.)]\s+", s):
                s = re.sub(r"^\d+[.)]\s+", "", s)
            # else: no marker at all — kept as-is (a model that ignored the format
            # still contributes its first line, and later lines survive below too).
            s = s.strip(" -*•\t")
            if not s:
                continue
            if len(s) > 200:
                s = s[:200]
            if s.lower() in (i.lower() for i in items):
                continue
            items.append(s)
        return items[:MAX_CHECKLIST_ITEMS]
    except Exception:
        return []


def FALLBACK_DRAFT(booking: dict, impact: dict) -> str:
    """Holding reply used when a model turn produced nothing (§5.7)."""
    cl = ", ".join(impact.get("matched_clause_ids", [])) or "none"
    return (
        f"Hi {booking['guest_name']} — I'm looking into this now. The platform updated "
        f"the policy this booking was made under ({cl}), so I want to give you the "
        f"correct answer rather than a quick one. I'll come back to you today with "
        f"what it means for your stay on {booking['check_in']}."
    )


def FALLBACK_CHECKLIST() -> list[str]:
    """Generic three-task checklist used when a model turn produced nothing (§5.7)."""
    return ["Take out the refuse", "Return the furniture to its original position",
            "Run the dishwasher"]


def SUMMARY_FOR(kind: str, impact: dict) -> str:
    """One sentence per decision kind, formatted with the booking's values (§5.8)."""
    b = impact["booking"]
    cl = ", ".join(impact.get("matched_clause_ids", [])) or "none"
    if kind == "refund":
        try:
            snaps = load_snapshots()
            stamp = snaps[-1]["captured_at"] if snaps else "unknown"
        except Exception:
            stamp = "unknown"
        return (f"{b['guest_name']} asked about cancelling {b['booking_id']}. "
                f"The refund rule changed on {stamp}, so the amount is your call.")
    if kind == "exception":
        return (f"{b['guest_name']} asked for something the updated policy now handles "
                f"differently ({cl}). Approving this is a money decision.")
    return (f"{b['listing_name']} has {b['prior_disputes']} prior disputes with "
            f"{b['guest_name']}, and the checkout rules just changed. Worth your eyes "
            f"before the turnover.")


def triage(impact: dict, draft_text: str) -> Optional[str]:
    """Decide whether the host must be asked, and what kind of ask it is (§5.5).

    Returns "refund", "exception", "review_risk", or None when the cycle may act
    quietly. Deterministic: given the same booking, the same matched clauses and the
    same draft text, it always returns the same answer.
    """
    try:
        booking = impact["booking"]
        if booking.get("status") == "cancellation_requested":
            return "refund"
        matched = impact.get("matched_clause_ids", [])
        for prefix, kind in ESCALATING_PREFIXES:
            if any(str(cid).startswith(prefix) for cid in matched):
                return kind
        if int(booking.get("prior_disputes", 0)) >= REVIEW_RISK_DISPUTES:
            return "review_risk"
        if MONEY_RE.search(draft_text or ""):
            return "exception"
        return None
    except Exception:
        return "exception"


def run_cycle(params: CycleParams | None = None) -> CycleResult:
    """Run one complete background cycle. Synchronous. Never raises (§5.6).

    Steps: fetch the latest policy capture, diff it against the previous one, select
    the affected bookings, then for each one run two Strands turns (reply, then
    checklist), triage the result, and either raise one decision for the host or act
    quietly and log it. Finishes by writing the run record and returning everything
    the API and the UI need.
    """
    cfg = load_app_config()
    params = params or {}
    trace_id = params.get("trace_id") or new_trace_id()
    set_trace(trace_id)
    run = create_run(trace_id)
    drafts: list[dict] = []
    checklists: list[dict] = []
    decisions: list[dict] = []
    quiet = 0
    tool_calls: list[str] = []
    degraded_any = False
    changed_ids: list[str] = []
    money_ids: list[str] = []
    bookings: list[dict] = []
    impacts: list[dict] = []
    previous_captured_at = ""
    latest_captured_at = ""
    try:
        t0 = time.perf_counter()
        emit("cycle", "started",
             {"run_id": run["run_id"], "demo_mode": cfg["demo_mode"]}, trace_id=trace_id)
        fetched = policy_fetch("latest")
        diff = policy_diff()
        changes = diff.get("changes", [])
        changed_ids = [c["clause_id"] for c in changes]
        money_ids = [c["clause_id"] for c in changes if c["money_related"]]
        previous_captured_at = diff.get("previous_captured_at", "")
        latest_captured_at = diff.get("latest_captured_at", "")
        audit_append("policy_change_detected", "",
                     f"{len(changes)} clause(s) changed between "
                     f"{diff.get('previous_captured_at', '?')} and "
                     f"{diff.get('latest_captured_at', '?')}: "
                     f"{', '.join(changed_ids) or 'none'}.",
                     trace_id=trace_id)
        bookings = load_bookings()
        snaps = load_snapshots()
        full_changes = diff_snapshots(snaps[-2], snaps[-1]) if len(snaps) >= 2 else []
        impacts = affected_bookings(bookings, full_changes)
        cap = int(params.get("max_bookings") or cfg["max_bookings"])
        if params.get("booking_filter"):
            impacts = [i for i in impacts
                       if i["booking"]["booking_id"] == params["booking_filter"]]
        impacts = impacts[:cap]
        emit("booking_scan", "done",
             {"scanned": len(bookings), "affected": len(impacts),
              "skipped": len(bookings) - len(impacts),
              "booking_ids": [i["booking"]["booking_id"] for i in impacts]},
             trace_id=trace_id)
        agent = build_agent(tools=ALL_TOOLS, system_prompt=load_prompt("system.stayquiet.md"))
        drain_tool_calls()
        for impact in impacts:
            b = impact["booking"]
            bid = b["booking_id"]
            cl = ", ".join(impact["matched_clause_ids"]) or "none"
            stamp = diff.get("latest_captured_at", "unknown")

            emit("draft_reply", "started", {"booking_id": bid, "guest_name": b["guest_name"]},
                 trace_id=trace_id)
            prompt = render(load_prompt("user.draft.md"), {
                "booking_id": bid, "guest_name": b["guest_name"],
                "listing_name": b["listing_name"], "check_in": b["check_in"],
                "check_out": b["check_out"], "status": b["status"],
                "prior_disputes": b["prior_disputes"], "clause_list": cl,
                "open_issue": b["open_issue"] or "nothing specific",
            })
            r = run_agent("draft_reply", agent, prompt, cache_key=f"draft::{bid}::{stamp}")
            text = r["text"].strip() or FALLBACK_DRAFT(b, impact)
            degraded_any = degraded_any or r["degraded"]
            drafts.append({"booking_id": bid, "text": text,
                           "degraded": r["degraded"], "source": r["source"]})
            # reason/fallback_source feed the pre-existing banner (UI-RES-02): without
            # them it normalizes to a bare "none" badge. Live turns carry neither key.
            draft_payload: dict = {"booking_id": bid, "chars": len(text),
                                   "source": r["source"], "text": text}
            if r["degraded"]:
                draft_payload["reason"] = ("served_from_golden_cache"
                                           if r["source"] == "cache" else "model_unavailable")
                draft_payload["fallback_source"] = ("cache" if r["source"] == "cache"
                                                    else "none")
            emit("draft_reply", "done", draft_payload,
                 trace_id=trace_id, degraded=r["degraded"])
            tool_calls += drain_tool_calls()

            emit("turnover_checklist", "started", {"booking_id": bid}, trace_id=trace_id)
            prompt2 = render(load_prompt("user.checklist.md"), {
                "booking_id": bid, "listing_name": b["listing_name"],
                "check_out": b["check_out"],
            })
            r2 = run_agent("turnover_checklist", agent, prompt2,
                           cache_key=f"checklist::{bid}::{stamp}")
            items = parse_checklist(r2["text"]) or FALLBACK_CHECKLIST()
            degraded_any = degraded_any or r2["degraded"]
            checklists.append({"booking_id": bid, "items": items,
                               "degraded": r2["degraded"], "source": r2["source"]})
            checklist_payload: dict = {"booking_id": bid, "items": items,
                                       "source": r2["source"]}
            if r2["degraded"]:
                checklist_payload["reason"] = ("served_from_golden_cache"
                                               if r2["source"] == "cache"
                                               else "model_unavailable")
                checklist_payload["fallback_source"] = ("cache" if r2["source"] == "cache"
                                                        else "none")
            emit("turnover_checklist", "done", checklist_payload,
                 trace_id=trace_id, degraded=r2["degraded"])
            tool_calls += drain_tool_calls()

            kind = triage(impact, text)
            emit("triage", "done",
                 {"booking_id": bid, "escalated": kind is not None, "kind": kind or "quiet",
                  "reasons": impact["reasons"]},
                 trace_id=trace_id)
            if kind is None:
                quiet += 1
                audit_append("resolved_quietly", bid,
                             f"Reply drafted and turnover checklist filed for "
                             f"{b['guest_name']} without asking the host: no money decision "
                             f"and no review risk ({', '.join(impact['reasons'])}).",
                             trace_id=trace_id, degraded=(r["degraded"] or r2["degraded"]))
            else:
                d = add_decision(
                    run_id=run["run_id"], trace_id=trace_id, booking_id=bid,
                    guest_name=b["guest_name"], listing_name=b["listing_name"], kind=kind,
                    summary=SUMMARY_FOR(kind, impact),
                    clause_ids=impact["matched_clause_ids"], draft_text=text,
                    checklist=items, payout_eur=b["payout_eur"],
                    degraded=(r["degraded"] or r2["degraded"]))
                decisions.append(d)
                audit_append("escalated_to_host", bid,
                             f"Held for the host as a {kind.replace('_', ' ')} decision: "
                             f"{d['summary']} Modelled exposure "
                             f"{d['modelled_exposure_eur']:.2f} EUR.",
                             trace_id=trace_id, degraded=d["degraded"])
        cost = cost_snapshot()
        elapsed = int((time.perf_counter() - t0) * 1000)
        summary = (f"{len(changes)} policy change(s); {len(impacts)} of {len(bookings)} bookings "
                   f"worked; {len(decisions)} decision(s) for you; {quiet} handled quietly.")
        finish_run(run["run_id"], status="done", bookings_scanned=len(bookings),
                   bookings_affected=len(impacts), changed_clauses=changed_ids,
                   decisions=[d["decision_id"] for d in decisions], quiet_actions=quiet,
                   degraded=degraded_any, elapsed_ms=elapsed, tokens=cost["total_tokens"],
                   summary=summary)
        emit("cycle", "done",
             {"run_id": run["run_id"], "summary": summary, "elapsed_ms": elapsed,
              "decisions": len(decisions), "quiet_actions": quiet,
              "tokens": cost["total_tokens"],
              "estimated_cost_usd": cost["estimated_cost_usd"]},
             trace_id=trace_id, degraded=degraded_any)
        return {
            "trace_id": trace_id,
            "run_id": run["run_id"],
            "previous_captured_at": previous_captured_at,
            "latest_captured_at": latest_captured_at,
            "changed_clauses": changed_ids,
            "money_clauses": money_ids,
            "bookings_scanned": len(bookings),
            "bookings_affected": len(impacts),
            "drafts": drafts,
            "checklists": checklists,
            "decisions": decisions,
            "quiet_actions": quiet,
            "tool_calls": tool_calls,
            "degraded": degraded_any,
            "elapsed_ms": elapsed,
            "tokens": cost["total_tokens"],
            "cost": cost,
            "summary": summary,
        }
    except Exception as err:
        try:
            emit("cycle", "error", {"error": str(err)[:400]}, trace_id=trace_id,
                 degraded=True)
        except Exception:
            pass
        try:
            audit_append("cycle_failed", "", f"Cycle stopped: {err}", trace_id=trace_id,
                         degraded=True)
        except Exception:
            pass
        try:
            finish_run(run["run_id"], status="error", degraded=True,
                       summary=f"Cycle failed: {err}")
        except Exception:
            pass
        try:
            cost = cost_snapshot()
        except Exception:
            cost = {"total_tokens": 0, "request_count": 0, "estimated_cost_usd": None,
                    "budget_tokens": 0, "utilization": 0.0, "warnings": []}
        return {
            "trace_id": trace_id,
            "run_id": run.get("run_id", "RUN-error"),
            "previous_captured_at": previous_captured_at,
            "latest_captured_at": latest_captured_at,
            "changed_clauses": changed_ids,
            "money_clauses": money_ids,
            "bookings_scanned": len(bookings),
            "bookings_affected": len(impacts),
            "drafts": drafts,
            "checklists": checklists,
            "decisions": decisions,
            "quiet_actions": quiet,
            "tool_calls": tool_calls,
            "degraded": True,
            "elapsed_ms": 0,
            "tokens": 0,
            "cost": cost,
            "summary": f"Cycle failed: {err}",
        }
