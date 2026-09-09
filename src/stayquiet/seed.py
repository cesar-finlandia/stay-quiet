# StayQuiet — synthetic data access plus the two deterministic computations over it
# (blueprint §2.4 rows 3-8). Pure functions of committed fixtures: no network, no
# model call, no randomness, no clock. Same input, same output, every run.
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Literal, Optional, TypedDict

from src.stayquiet.config import load_app_config, repo_root

BookingStatus = Literal["confirmed", "cancellation_requested"]
OpenIssue = Literal["guest_question", "cleaner_dispute"]
ChangeKind = Literal["added", "removed", "modified"]

#: Clause-id prefixes that make a change money-related regardless of wording.
MONEY_PREFIXES: tuple[str, ...] = ("cancellation", "payments", "fees")

#: Lowercase substrings that make a clause money-related when found in its text.
MONEY_TERMS: tuple[str, ...] = (
    "refund", "payout", "fee", "charge", "installment", "instalment", "deposit", "€",
)


class GuestMessage(TypedDict):
    """One message in a booking's guest thread, oldest first."""

    at: str        # ISO-8601 date-time
    sender: Literal["guest", "host", "cleaner"]
    text: str


class Booking(TypedDict):
    """One synthetic booking. `synthetic` is always True (never omit it)."""

    synthetic: Literal[True]
    booking_id: str
    listing_id: str
    listing_name: str
    guest_name: str
    check_in: str          # YYYY-MM-DD
    check_out: str         # YYYY-MM-DD
    nights: int
    payout_eur: float
    status: BookingStatus
    policy_refs: list[str]          # clause ids this booking was sold under
    prior_disputes: int             # count of past disputes on this listing/guest
    open_issue: Optional[OpenIssue]  # None when nothing is waiting on the host
    cleaner_notes: Optional[str]
    guest_messages: list[GuestMessage]


class PolicyClause(TypedDict):
    """One clause of a help-centre policy snapshot."""

    clause_id: str
    title: str
    text: str


class PolicySnapshot(TypedDict):
    """One dated capture of the platform's public policy text."""

    synthetic: Literal[True]
    captured_at: str   # YYYY-MM-DD
    source: str        # human description of where the snapshot came from
    clauses: list[PolicyClause]


class ClauseChange(TypedDict):
    """One clause-level difference between two snapshots."""

    clause_id: str
    title: str
    change_kind: ChangeKind
    previous_text: Optional[str]   # None when change_kind == "added"
    latest_text: Optional[str]     # None when change_kind == "removed"
    money_related: bool


class BookingImpact(TypedDict):
    """One booking that this cycle must work on, plus why."""

    booking: Booking
    matched_clause_ids: list[str]   # sorted; may be empty when reason is an open issue
    reasons: list[str]              # human-readable, sorted, e.g. ["policy_change:cancellation.moderate", "open_issue:guest_question"]


def fixtures_path(fixtures_dir: str | None = None) -> Path:
    """Absolute path of the synthetic fixtures directory.

    Resolves `fixtures_dir` (default: AppConfig["fixtures_dir"]) against the
    repository root when it is relative.
    """
    raw = fixtures_dir if fixtures_dir is not None else load_app_config()["fixtures_dir"]
    p = Path(raw)
    if not p.is_absolute():
        p = repo_root() / p
    return p


def load_bookings(fixtures_dir: str | None = None) -> list[Booking]:
    """Read fixtures/synthetic/bookings.json.

    Returns the bookings in file order. A missing or malformed file returns an
    empty list after printing one stderr warning — never raises. Any record whose
    `synthetic` field is not True is dropped with a warning (SQ-N-03 guard).
    """
    target = fixtures_path(fixtures_dir) / "bookings.json"
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"[stayquiet] bookings file {target} not found; returning empty list",
              file=sys.stderr)
        return []
    except Exception as err:  # noqa: BLE001 — data loading must never crash the app
        print(f"[stayquiet] bookings file {target} unreadable ({err}); returning empty list",
              file=sys.stderr)
        return []
    if not isinstance(raw, list):
        print(f"[stayquiet] bookings file {target} unreadable (root is not a list); "
              f"returning empty list", file=sys.stderr)
        return []
    out: list[Booking] = []
    for i, rec in enumerate(raw):
        if not isinstance(rec, dict) or rec.get("synthetic") is not True:
            label = rec.get("booking_id", f"index {i}") if isinstance(rec, dict) else f"index {i}"
            print(f"[stayquiet] booking {label} is not marked synthetic; skipped",
                  file=sys.stderr)
            continue
        out.append(rec)
    return out


def load_snapshots(fixtures_dir: str | None = None) -> list[PolicySnapshot]:
    """Read every *.json under fixtures/synthetic/policy_snapshots/.

    Returns them sorted ASCENDING by `captured_at`, so `[-1]` is the newest and
    `[-2]` the one before it. A missing directory returns an empty list after one
    stderr warning — never raises.
    """
    d = fixtures_path(fixtures_dir) / "policy_snapshots"
    if not d.is_dir():
        print(f"[stayquiet] policy snapshots directory {d} not found; "
              f"policy watching disabled", file=sys.stderr)
        return []
    items: list[PolicySnapshot] = []
    for path in sorted(d.glob("*.json")):
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except Exception as err:  # noqa: BLE001 — one bad file must not break the walk
            print(f"[stayquiet] snapshot {path.name} unreadable ({err}); skipped",
                  file=sys.stderr)
            continue
        if not isinstance(obj, dict) or obj.get("synthetic") is not True:
            print(f"[stayquiet] snapshot {path.name} is not marked synthetic; skipped",
                  file=sys.stderr)
            continue
        items.append(obj)
    return sorted(items, key=lambda s: s["captured_at"])


def is_money_related(clause_id: str, text: str | None) -> bool:
    """True when a clause is about money.

    Rule (deterministic, no judgement): True if `clause_id` starts with any entry
    of MONEY_PREFIXES followed by "." or end-of-string, OR if any entry of
    MONEY_TERMS appears in `text.lower()`. False when text is None and no prefix
    matches.
    """
    cid = clause_id.strip().lower()
    for p in MONEY_PREFIXES:
        if cid == p or cid.startswith(p + "."):
            return True
    if text is None or not text:
        return False
    t = text.lower()
    return any(term in t for term in MONEY_TERMS)


def diff_snapshots(previous: PolicySnapshot, latest: PolicySnapshot) -> list[ClauseChange]:
    """Clause-level diff between two snapshots, sorted by clause_id.

    A clause id present only in `latest` is "added"; only in `previous` is
    "removed"; present in both with different `text` (after stripping leading and
    trailing whitespace) is "modified". Identical clauses produce no entry.
    `title` comes from `latest` when available, otherwise `previous`.
    """
    prev = {c["clause_id"]: c for c in previous["clauses"]}
    curr = {c["clause_id"]: c for c in latest["clauses"]}
    out: list[ClauseChange] = []
    for cid in sorted(set(prev) | set(curr)):
        p = prev.get(cid)
        c = curr.get(cid)
        if p is None and c is not None:
            out.append({
                "clause_id": cid,
                "title": c["title"],
                "change_kind": "added",
                "previous_text": None,
                "latest_text": c["text"],
                "money_related": is_money_related(cid, c["text"]),
            })
        elif c is None and p is not None:
            out.append({
                "clause_id": cid,
                "title": p["title"],
                "change_kind": "removed",
                "previous_text": p["text"],
                "latest_text": None,
                "money_related": is_money_related(cid, p["text"]),
            })
        elif p is not None and c is not None and p["text"].strip() != c["text"].strip():
            out.append({
                "clause_id": cid,
                "title": c["title"],
                "change_kind": "modified",
                "previous_text": p["text"],
                "latest_text": c["text"],
                "money_related": is_money_related(cid, c["text"] or p["text"]),
            })
    return out


def affected_bookings(bookings: list[Booking], changes: list[ClauseChange]) -> list[BookingImpact]:
    """Select the bookings this cycle must work on.

    A booking is affected when EITHER at least one changed clause id appears in
    its `policy_refs`, OR its `open_issue` is not None. Output preserves the input
    order of `bookings`; `matched_clause_ids` and `reasons` are sorted. Bookings
    that are neither are omitted entirely — the caller reports the skipped count
    as len(bookings) - len(result).
    """
    changed_ids = {ch["clause_id"] for ch in changes}
    out: list[BookingImpact] = []
    for b in bookings:
        matched = sorted(set(b["policy_refs"]) & changed_ids)
        reasons = [f"policy_change:{cid}" for cid in matched]
        if b["open_issue"] is not None:
            reasons.append(f"open_issue:{b['open_issue']}")
        if b["status"] == "cancellation_requested":
            reasons.append("status:cancellation_requested")
        if not matched and b["open_issue"] is None:
            continue
        out.append({
            "booking": b,
            "matched_clause_ids": matched,
            "reasons": sorted(reasons),
        })
    return out


def find_booking(booking_id: str, bookings: list[Booking] | None = None) -> Booking | None:
    """Look one booking up by id (case-sensitive, exact). Loads the fixtures when
    `bookings` is None. Returns None when there is no match — never raises."""
    items = bookings if bookings is not None else load_bookings()
    for b in items:
        if b["booking_id"] == booking_id:
            return b
    return None


def thread_messages(booking: Booking) -> list[dict]:
    """Convert a booking's guest thread into the role/content message shape the
    context buffer expects: {"role": "user"|"assistant", "content": str}. A
    message whose sender is "host" maps to role "assistant"; "guest" and "cleaner"
    map to role "user". Oldest first, order preserved."""
    role_of = {"host": "assistant"}
    return [
        {"role": role_of.get(m["sender"], "user"), "content": m["text"]}
        for m in booking["guest_messages"]
    ]
