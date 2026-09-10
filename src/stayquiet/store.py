# StayQuiet — the ONLY owner of run and decision state (blueprint §2.4 rows 23-25,
# §2.4c rule 5). In-process, lock-guarded, no database (a hackathon demo has one
# host and one process). The agent creates runs and decisions; the API reads them
# and resolves them.
from __future__ import annotations

import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional, TypedDict

DecisionKind = Literal["refund", "exception", "review_risk"]
DecisionStatus = Literal["pending", "approved", "edited"]
RunStatus = Literal["running", "done", "error"]

#: Modelled exposure multiplier per decision kind (blueprint §1, SQ-F-06).
#: These are MODELLED weights, not measurements, and every surface says so.
EXPOSURE_FACTOR: dict[str, float] = {
    "refund": 1.0,
    "exception": 0.5,
    "review_risk": 0.25,
}


class Decision(TypedDict):
    """One thing the host must decide. Created by the agent, resolved by the host."""

    decision_id: str          # "DEC-<8 hex>"
    run_id: str
    trace_id: str
    booking_id: str
    guest_name: str
    listing_name: str
    kind: DecisionKind
    summary: str              # one sentence: why the host is being asked
    clause_ids: list[str]     # the policy clauses behind the ask
    draft_text: str           # the reply the agent proposes to send
    checklist: list[str]      # the turnover checklist for this stay (may be empty)
    modelled_exposure_eur: float   # payout_eur * EXPOSURE_FACTOR[kind], rounded to 2dp — MODELLED
    status: DecisionStatus
    created_at: str           # ISO-8601 UTC
    resolved_at: Optional[str]
    final_text: Optional[str]  # draft_text on approve, the host's text on edit
    degraded: bool             # True when the draft came from the golden cache or a fallback


class RunRecord(TypedDict):
    """One background cycle."""

    run_id: str               # "RUN-<8 hex>"
    trace_id: str
    started_at: str
    finished_at: Optional[str]
    status: RunStatus
    bookings_scanned: int
    bookings_affected: int
    changed_clauses: list[str]
    decisions: list[str]      # decision_ids raised by this run
    quiet_actions: int        # actions taken without asking the host
    degraded: bool
    elapsed_ms: int
    tokens: int
    summary: str


_lock = threading.Lock()
_runs: dict[str, RunRecord] = {}
_run_order: list[str] = []
_decisions: dict[str, Decision] = {}
_decision_order: list[str] = []


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_run(trace_id: str) -> RunRecord:
    """Open a run in status "running" with zeroed counters. Never raises."""
    try:
        with _lock:
            run_id = "RUN-" + uuid.uuid4().hex[:8]
            record: RunRecord = {
                "run_id": run_id,
                "trace_id": str(trace_id),
                "started_at": _now(),
                "finished_at": None,
                "status": "running",
                "bookings_scanned": 0,
                "bookings_affected": 0,
                "changed_clauses": [],
                "decisions": [],
                "quiet_actions": 0,
                "degraded": False,
                "elapsed_ms": 0,
                "tokens": 0,
                "summary": "",
            }
            _runs[run_id] = record
            _run_order.append(run_id)
            return dict(record)
    except Exception:
        return {
            "run_id": "RUN-error",
            "trace_id": str(trace_id),
            "started_at": _now(),
            "finished_at": None,
            "status": "error",
            "bookings_scanned": 0,
            "bookings_affected": 0,
            "changed_clauses": [],
            "decisions": [],
            "quiet_actions": 0,
            "degraded": True,
            "elapsed_ms": 0,
            "tokens": 0,
            "summary": "",
        }


def finish_run(run_id: str, **fields) -> Optional[RunRecord]:
    """Set finished_at and merge the given fields into the run.

    Accepted field names are exactly the RunRecord keys other than run_id,
    trace_id and started_at; anything else is ignored with one stderr warning.
    Returns the updated record, or None when run_id is unknown. Never raises.
    """
    try:
        allowed = {"status", "bookings_scanned", "bookings_affected", "changed_clauses",
                   "decisions", "quiet_actions", "degraded", "elapsed_ms", "tokens",
                   "summary", "finished_at"}
        with _lock:
            record = _runs.get(run_id)
            if record is None:
                return None
            record["finished_at"] = _now()
            for key, value in fields.items():
                if key in allowed:
                    record[key] = value  # type: ignore[literal-required]
                else:
                    print(f"[stayquiet] finish_run ignoring unknown field \"{key}\"",
                          file=sys.stderr)
            return dict(record)
    except Exception:
        return None


def get_run(run_id: str) -> Optional[RunRecord]:
    """One run by id, or None."""
    try:
        with _lock:
            record = _runs.get(run_id)
            return dict(record) if record is not None else None
    except Exception:
        return None


def latest_run() -> Optional[RunRecord]:
    """The most recently created run, or None when none has run yet."""
    try:
        with _lock:
            if not _run_order:
                return None
            return dict(_runs[_run_order[-1]])
    except Exception:
        return None


def list_runs(limit: int = 20) -> list[RunRecord]:
    """Newest first, at most `limit`."""
    try:
        with _lock:
            return [dict(_runs[rid]) for rid in reversed(_run_order[:])][:limit]
    except Exception:
        return []


def add_decision(
    *,
    run_id: str,
    trace_id: str,
    booking_id: str,
    guest_name: str,
    listing_name: str,
    kind: DecisionKind,
    summary: str,
    clause_ids: list[str],
    draft_text: str,
    checklist: list[str],
    payout_eur: float,
    degraded: bool = False,
) -> Decision:
    """Record one pending decision and append its id to its run.

    `modelled_exposure_eur` is computed here as
    round(payout_eur * EXPOSURE_FACTOR[kind], 2) — the single place that formula
    lives. An unknown `kind` falls back to factor 0.25 with one stderr warning.
    Never raises.
    """
    try:
        factor = EXPOSURE_FACTOR.get(kind)  # type: ignore[arg-type]
        if factor is None:
            print(f"[stayquiet] unknown decision kind \"{kind}\"; using exposure factor 0.25",
                  file=sys.stderr)
            factor = 0.25
        exposure = round(float(payout_eur) * factor, 2)
    except Exception:
        exposure = 0.0
    try:
        with _lock:
            decision_id = "DEC-" + uuid.uuid4().hex[:8]
            decision: Decision = {
                "decision_id": decision_id,
                "run_id": str(run_id),
                "trace_id": str(trace_id),
                "booking_id": str(booking_id),
                "guest_name": str(guest_name),
                "listing_name": str(listing_name),
                "kind": kind,
                "summary": str(summary),
                "clause_ids": list(clause_ids),
                "draft_text": str(draft_text),
                "checklist": list(checklist),
                "modelled_exposure_eur": exposure,
                "status": "pending",
                "created_at": _now(),
                "resolved_at": None,
                "final_text": None,
                "degraded": bool(degraded),
            }
            _decisions[decision_id] = decision
            _decision_order.append(decision_id)
            run = _runs.get(run_id)
            if run is not None:
                run["decisions"].append(decision_id)
            return dict(decision)
    except Exception:
        return {
            "decision_id": "DEC-error",
            "run_id": str(run_id),
            "trace_id": str(trace_id),
            "booking_id": str(booking_id),
            "guest_name": str(guest_name),
            "listing_name": str(listing_name),
            "kind": "review_risk",
            "summary": str(summary),
            "clause_ids": [],
            "draft_text": str(draft_text),
            "checklist": [],
            "modelled_exposure_eur": 0.0,
            "status": "pending",
            "created_at": _now(),
            "resolved_at": None,
            "final_text": None,
            "degraded": True,
        }


def list_decisions(status: str | None = None) -> list[Decision]:
    """Newest first. Filtered by status when given ("pending"/"approved"/"edited")."""
    try:
        with _lock:
            items = [dict(_decisions[did]) for did in reversed(_decision_order[:])]
        if status is not None:
            items = [d for d in items if d.get("status") == status]
        return items
    except Exception:
        return []


def get_decision(decision_id: str) -> Optional[Decision]:
    """One decision by id, or None."""
    try:
        with _lock:
            decision = _decisions.get(decision_id)
            return dict(decision) if decision is not None else None
    except Exception:
        return None


def resolve_decision(
    decision_id: str,
    action: str,
    edited_text: str | None = None,
) -> Optional[Decision]:
    """Apply the host's answer. `action` is "approve" or "edit".

    approve → status "approved", final_text = draft_text.
    edit    → status "edited",   final_text = edited_text (required, non-empty).
    Returns the updated decision; returns None when decision_id is unknown, when
    action is neither value, or when edit was asked for without text. An already
    resolved decision is returned unchanged (idempotent). Never raises.
    """
    try:
        with _lock:
            d = _decisions.get(decision_id)
            if d is None:
                return None
            if d["status"] != "pending":
                return dict(d)
            if action == "approve":
                d["status"] = "approved"
                d["final_text"] = d["draft_text"]
            elif action == "edit":
                if edited_text is None or edited_text.strip() == "":
                    return None
                d["status"] = "edited"
                d["final_text"] = edited_text
            else:
                return None
            d["resolved_at"] = _now()
            return dict(d)
    except Exception:
        return None


def reset() -> None:
    """Clear all runs and decisions. Tests only."""
    with _lock:
        _runs.clear()
        _run_order.clear()
        _decisions.clear()
        _decision_order.clear()
