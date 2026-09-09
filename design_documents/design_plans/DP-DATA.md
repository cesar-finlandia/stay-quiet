# DP-DATA — Synthetic bookings, policy snapshots, diff and impact matching

## §0 Context & blockers

Must already exist before WU-DATA-01 runs (all produced by **DP-FOUND**):

* `src/stayquiet/config.py` exporting `AppConfig`, `load_app_config()`, `repo_root()`.
* `src/stayquiet/__init__.py`, `engine/__init__.py`, `contracts/tokenizer-profiles.json`.
* `requirements.txt` installed (`pip install -r requirements.txt`).

Pre-existing and read-only: `src/data/` (the synthetic-data generator, TypeScript),
`src/resilience/`.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Own all data that enters the agent loop, and own every deterministic computation over it: the
clause-level policy diff and the booking-impact match. Nothing here calls a model.

Requirements (blueprint §1): **SQ-F-01** (synthetic feed + two dated snapshots, every record
marked `synthetic: true`), **SQ-F-02** (deterministic clause diff with add/remove/modify and a
money flag), **SQ-F-03** (only touched bookings selected; the rest counted and skipped),
**SQ-N-03** (zero real personal data), **SQ-N-04** (diff/match are pure Python, not LLM calls).

## §2 Scope boundaries

### IN — the only files this plan creates

1. `fixtures/synthetic/bookings.json`
2. `fixtures/synthetic/policy_snapshots/2026-08-01.json`
3. `fixtures/synthetic/policy_snapshots/2026-09-08.json`
4. `src/stayquiet/seed.py`
5. `scripts/generate_fixtures.mjs` (optional regeneration path; **not** a build dependency)

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `config/stayquiet.json`, `src/stayquiet/config.py` | DP-FOUND |
| `src/stayquiet/model.py`, `src/stayquiet/context_bridge.py` | DP-MODEL |
| `src/stayquiet/publish.py`, `src/stayquiet/store.py`, `src/stayquiet/audit.py` | DP-STREAM |
| `engine/tools/*.py` | DP-TOOLS |
| `engine/agents/stayquiet_agent.py` (the triage rule lives there, NOT here) | DP-AGENT |
| `src/stayquiet/api.py` | DP-API |
| `fixtures/golden/**` | DP-DEPLOY |
| anything under `src/data/`, `src/resilience/` | pre-existing modules — read-only |

`seed.py` must not import `emit`, must not import `run_agent`, and must not decide whether a
booking is escalated — it only reports *facts*. Triage is DP-AGENT's.

## §3 Interfaces owned

Complete skeleton of `src/stayquiet/seed.py`. Every signature, field name and docstring below is
literal.

```python
# StayQuiet — synthetic data access plus the two deterministic computations over it
# (blueprint §2.4 rows 3-8). Pure functions of committed fixtures: no network, no
# model call, no randomness, no clock. Same input, same output, every run.
from __future__ import annotations

import json
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


def load_bookings(fixtures_dir: str | None = None) -> list[Booking]:
    """Read fixtures/synthetic/bookings.json.

    Returns the bookings in file order. A missing or malformed file returns an
    empty list after printing one stderr warning — never raises. Any record whose
    `synthetic` field is not True is dropped with a warning (SQ-N-03 guard).
    """


def load_snapshots(fixtures_dir: str | None = None) -> list[PolicySnapshot]:
    """Read every *.json under fixtures/synthetic/policy_snapshots/.

    Returns them sorted ASCENDING by `captured_at`, so `[-1]` is the newest and
    `[-2]` the one before it. A missing directory returns an empty list after one
    stderr warning — never raises.
    """


def is_money_related(clause_id: str, text: str | None) -> bool:
    """True when a clause is about money.

    Rule (deterministic, no judgement): True if `clause_id` starts with any entry
    of MONEY_PREFIXES followed by "." or end-of-string, OR if any entry of
    MONEY_TERMS appears in `text.lower()`. False when text is None and no prefix
    matches.
    """


def diff_snapshots(previous: PolicySnapshot, latest: PolicySnapshot) -> list[ClauseChange]:
    """Clause-level diff between two snapshots, sorted by clause_id.

    A clause id present only in `latest` is "added"; only in `previous` is
    "removed"; present in both with different `text` (after stripping leading and
    trailing whitespace) is "modified". Identical clauses produce no entry.
    `title` comes from `latest` when available, otherwise `previous`.
    """


def affected_bookings(bookings: list[Booking], changes: list[ClauseChange]) -> list[BookingImpact]:
    """Select the bookings this cycle must work on.

    A booking is affected when EITHER at least one changed clause id appears in
    its `policy_refs`, OR its `open_issue` is not None. Output preserves the input
    order of `bookings`; `matched_clause_ids` and `reasons` are sorted. Bookings
    that are neither are omitted entirely — the caller reports the skipped count
    as len(bookings) - len(result).
    """


def find_booking(booking_id: str, bookings: list[Booking] | None = None) -> Booking | None:
    """Look one booking up by id (case-sensitive, exact). Loads the fixtures when
    `bookings` is None. Returns None when there is no match — never raises."""


def thread_messages(booking: Booking) -> list[dict]:
    """Convert a booking's guest thread into the role/content message shape the
    context buffer expects: {"role": "user"|"assistant", "content": str}. A
    message whose sender is "host" maps to role "assistant"; "guest" and "cleaner"
    map to role "user". Oldest first, order preserved."""
```

## §4 Interfaces consumed

```python
from src.stayquiet.config import load_app_config, repo_root  # owned by DP-FOUND
```

`scripts/generate_fixtures.mjs` additionally consumes (owned by the pre-existing data module):

```javascript
import { generateRecords, generateDocuments } from "src/data/index.js";
```

Nothing else. In particular this plan does NOT import `emit`, `run_agent`, `audit_append`, or
anything from `engine/`.

## §5 Literal fixture contents

These three files are the source of truth and are committed. `scripts/generate_fixtures.mjs`
exists only so the operator *can* regenerate variants; the build never depends on it and never
depends on `OPENAI_API_KEY`.

Naming rule for every value below: all guests, listings, notes and figures are invented. No real
person, property, address, phone number, email or booking reference appears anywhere.

### §5.1 `fixtures/synthetic/policy_snapshots/2026-08-01.json`

```json
{
  "synthetic": true,
  "captured_at": "2026-08-01",
  "source": "synthetic stand-in for a public short-stay platform help-centre capture",
  "clauses": [
    {
      "clause_id": "cancellation.moderate",
      "title": "Moderate cancellation policy",
      "text": "A guest who cancels at least 5 days before check-in receives a refund of every night except the first. Inside 5 days, the first night and 50 percent of the remaining nights are non-refundable. The cleaning fee is always refunded when the stay does not happen."
    },
    {
      "clause_id": "cancellation.strict",
      "title": "Strict cancellation policy",
      "text": "A guest who cancels after booking receives a refund of 50 percent of the nightly rate only if the cancellation is made within 48 hours of booking and at least 14 days before check-in. No refund is issued after that window."
    },
    {
      "clause_id": "payments.installments",
      "title": "Paying in instalments",
      "text": "A guest may ask the host to split the payout across two instalments. The host may agree in writing and collect the second instalment directly, provided the total charged matches the booking total."
    },
    {
      "clause_id": "cleaning.checkout_tasks",
      "title": "Checkout tasks a host may require",
      "text": "A host may list checkout tasks in the house rules, including stripping the bed linen, running the dishwasher, taking out refuse and returning furniture to its original position. A guest who skips a listed task may be charged the documented cost of completing it."
    },
    {
      "clause_id": "cleaning.fee_disputes",
      "title": "Disputed cleaning charges",
      "text": "A host who charges a guest for extra cleaning must provide dated photographs and a written description within 14 days of checkout. Charges without evidence are reversed."
    },
    {
      "clause_id": "reviews.retaliation",
      "title": "Reviews after a dispute",
      "text": "Neither party may condition a review on the outcome of a payment dispute. A review that references a refund negotiation may be removed on request."
    }
  ]
}
```

### §5.2 `fixtures/synthetic/policy_snapshots/2026-09-08.json`

Three clauses are modified, one is added, two are byte-identical. That is exactly what the diff
must report: **4 changes, 3 of which touch bookings**.

```json
{
  "synthetic": true,
  "captured_at": "2026-09-08",
  "source": "synthetic stand-in for a public short-stay platform help-centre capture",
  "clauses": [
    {
      "clause_id": "cancellation.moderate",
      "title": "Moderate cancellation policy",
      "text": "A guest who cancels at least 7 days before check-in receives a full refund of every night including the first. Inside 7 days, the first night is non-refundable and the remaining nights are refunded in full. The cleaning fee is always refunded when the stay does not happen."
    },
    {
      "clause_id": "cancellation.strict",
      "title": "Strict cancellation policy",
      "text": "A guest who cancels after booking receives a refund of 50 percent of the nightly rate only if the cancellation is made within 48 hours of booking and at least 14 days before check-in. No refund is issued after that window."
    },
    {
      "clause_id": "payments.installments",
      "title": "Paying in instalments",
      "text": "Instalment plans are arranged by the platform only. A host must not agree to collect any part of a booking total directly, and must not accept a bank transfer, a payment link or cash for a stay booked on the platform. A host who does so forfeits payout protection for that stay."
    },
    {
      "clause_id": "cleaning.checkout_tasks",
      "title": "Checkout tasks a host may require",
      "text": "A host may require a guest to take out refuse, return furniture to its original position and run the dishwasher. A host may no longer require a guest to strip bed linen or launder textiles, and may not charge a guest for skipping either. Charges for the permitted tasks still require documented cost."
    },
    {
      "clause_id": "cleaning.fee_disputes",
      "title": "Disputed cleaning charges",
      "text": "A host who charges a guest for extra cleaning must provide dated photographs and a written description within 14 days of checkout. Charges without evidence are reversed."
    },
    {
      "clause_id": "reviews.retaliation",
      "title": "Reviews after a dispute",
      "text": "Neither party may condition a review on the outcome of a payment dispute. A review that references a refund negotiation may be removed on request."
    },
    {
      "clause_id": "safety.co_alarm",
      "title": "Carbon monoxide alarm confirmation",
      "text": "A host with a fuel-burning appliance must confirm in the listing that a working carbon monoxide alarm is installed, and must re-confirm it every 12 months."
    }
  ]
}
```

### §5.3 `fixtures/synthetic/bookings.json`

Six bookings. Four are affected by the diff above, two are not — so the run reports
`4 of 6 bookings affected, 2 skipped`, deterministically.

```json
[
  {
    "synthetic": true,
    "booking_id": "BK-1042",
    "listing_id": "L-2",
    "listing_name": "Harbour Studio",
    "guest_name": "Maya Okafor",
    "check_in": "2026-09-18",
    "check_out": "2026-09-21",
    "nights": 3,
    "payout_eur": 612.0,
    "status": "confirmed",
    "policy_refs": ["cancellation.moderate", "payments.installments"],
    "prior_disputes": 0,
    "open_issue": "guest_question",
    "cleaner_notes": null,
    "guest_messages": [
      { "at": "2026-09-07T18:22:00Z", "sender": "guest", "text": "Hi! We are really looking forward to the studio. Would it be possible to pay in two parts, half now and half a week before we arrive? Money is a bit tight until payday." },
      { "at": "2026-09-07T20:05:00Z", "sender": "host", "text": "Hello Maya, thanks for asking. Let me check what is allowed and come back to you tomorrow." },
      { "at": "2026-09-09T08:14:00Z", "sender": "guest", "text": "No rush. If it helps I can send the second half by bank transfer directly to you." }
    ]
  },
  {
    "synthetic": true,
    "booking_id": "BK-1043",
    "listing_id": "L-1",
    "listing_name": "Old Town Loft",
    "guest_name": "Tomas Rivera",
    "check_in": "2026-09-15",
    "check_out": "2026-09-17",
    "nights": 2,
    "payout_eur": 418.0,
    "status": "confirmed",
    "policy_refs": ["cleaning.checkout_tasks"],
    "prior_disputes": 1,
    "open_issue": "cleaner_dispute",
    "cleaner_notes": "Guest left the bed made up. I stripped and bagged the linen myself, that is 20 minutes I am not paid for. Last month you told me to charge the guest for this.",
    "guest_messages": [
      { "at": "2026-09-08T11:40:00Z", "sender": "guest", "text": "Checking in on Tuesday around six, is that still fine?" },
      { "at": "2026-09-08T12:02:00Z", "sender": "host", "text": "Six works. The lockbox code is in the arrival note." },
      { "at": "2026-09-09T09:30:00Z", "sender": "cleaner", "text": "Reminder that the house rules still say strip the linen. Do I keep charging for it or not?" }
    ]
  },
  {
    "synthetic": true,
    "booking_id": "BK-1044",
    "listing_id": "L-2",
    "listing_name": "Harbour Studio",
    "guest_name": "Anneli Virtanen",
    "check_in": "2026-09-12",
    "check_out": "2026-09-14",
    "nights": 2,
    "payout_eur": 395.0,
    "status": "cancellation_requested",
    "policy_refs": ["cancellation.moderate"],
    "prior_disputes": 0,
    "open_issue": "guest_question",
    "cleaner_notes": null,
    "guest_messages": [
      { "at": "2026-09-09T07:11:00Z", "sender": "guest", "text": "I am so sorry, my father is in hospital and I have to cancel. I read that cancelling five days ahead gets everything back except the first night. Is that right?" },
      { "at": "2026-09-09T07:19:00Z", "sender": "guest", "text": "I would rather not lose the whole amount, it was a lot for us." }
    ]
  },
  {
    "synthetic": true,
    "booking_id": "BK-1045",
    "listing_id": "L-3",
    "listing_name": "Lakeside Cabin",
    "guest_name": "Jonas Weber",
    "check_in": "2026-09-22",
    "check_out": "2026-09-26",
    "nights": 4,
    "payout_eur": 964.0,
    "status": "confirmed",
    "policy_refs": ["cancellation.strict", "cleaning.fee_disputes"],
    "prior_disputes": 0,
    "open_issue": null,
    "cleaner_notes": null,
    "guest_messages": [
      { "at": "2026-09-05T15:00:00Z", "sender": "guest", "text": "Booked, thanks. See you in a couple of weeks." }
    ]
  },
  {
    "synthetic": true,
    "booking_id": "BK-1046",
    "listing_id": "L-1",
    "listing_name": "Old Town Loft",
    "guest_name": "Priya Nair",
    "check_in": "2026-09-19",
    "check_out": "2026-09-20",
    "nights": 1,
    "payout_eur": 187.0,
    "status": "confirmed",
    "policy_refs": ["cancellation.strict"],
    "prior_disputes": 0,
    "open_issue": null,
    "cleaner_notes": null,
    "guest_messages": [
      { "at": "2026-09-06T10:12:00Z", "sender": "guest", "text": "One night only, arriving late. No questions from me." }
    ]
  },
  {
    "synthetic": true,
    "booking_id": "BK-1047",
    "listing_id": "L-3",
    "listing_name": "Lakeside Cabin",
    "guest_name": "Sofia Marino",
    "check_in": "2026-09-28",
    "check_out": "2026-10-02",
    "nights": 4,
    "payout_eur": 1052.0,
    "status": "confirmed",
    "policy_refs": ["cleaning.checkout_tasks", "reviews.retaliation"],
    "prior_disputes": 2,
    "open_issue": "guest_question",
    "cleaner_notes": "This is the guest who argued about the linen charge in July and then again in August. Please tell me in advance what I am allowed to charge for so I am not the one arguing at the door.",
    "guest_messages": [
      { "at": "2026-08-02T09:04:00Z", "sender": "guest", "text": "We stayed at the cabin in July and were charged forty euro for cleaning we had already done ourselves. I would like that looked at again, because we followed every instruction in the arrival note and took photographs before we left." },
      { "at": "2026-08-02T17:40:00Z", "sender": "host", "text": "I am sorry that was frustrating. The charge came from the linen task in the house rules. Let me review the photographs you sent and come back to you." },
      { "at": "2026-08-04T08:15:00Z", "sender": "guest", "text": "Thank you. To be clear I am not disputing the stay, only the extra charge. We enjoyed the cabin and would like to come back, but I do not want a surprise charge a second time." },
      { "at": "2026-08-04T19:22:00Z", "sender": "host", "text": "Understood. I refunded twenty euro as a goodwill gesture and made a note on your booking so the same charge is not applied again." },
      { "at": "2026-08-19T12:30:00Z", "sender": "guest", "text": "We are back for four nights at the end of September, arriving on the twenty-eighth. Could you confirm what we are expected to do at checkout this time, in writing, so there is no confusion for either of us?" },
      { "at": "2026-08-19T13:02:00Z", "sender": "host", "text": "Of course. I will send the checkout list once I have confirmed which tasks I am still allowed to require." },
      { "at": "2026-08-27T10:47:00Z", "sender": "guest", "text": "Another question while I remember. The cabin listing mentions a wood stove. Is there a carbon monoxide alarm in the room with the stove? We are bringing our two year old and I would like to know before we arrive." },
      { "at": "2026-08-27T11:15:00Z", "sender": "host", "text": "There is an alarm in the hallway. I will check the date on it and confirm." },
      { "at": "2026-09-01T16:20:00Z", "sender": "guest", "text": "Following up on the checkout list and the alarm. Sorry to keep asking, it is only because of the charge last time and because of the little one." },
      { "at": "2026-09-03T07:55:00Z", "sender": "cleaner", "text": "For this booking please tell me the exact tasks before the turnover. I do not want another conversation about linen with this guest." },
      { "at": "2026-09-05T09:31:00Z", "sender": "guest", "text": "One more thing. We may need to shift our arrival by one day depending on a train strike. If we do, does that change anything about the booking or the amount?" },
      { "at": "2026-09-06T18:44:00Z", "sender": "guest", "text": "Also, my partner asked whether we can leave two bicycles somewhere covered overnight. Happy to be told no, just want to plan." },
      { "at": "2026-09-08T08:09:00Z", "sender": "guest", "text": "I saw a notice that the cleaning rules changed. Does that affect what we have to do at checkout, and does it affect the charge from July at all?" },
      { "at": "2026-09-09T06:50:00Z", "sender": "guest", "text": "No pressure on any of this. A single message covering the checkout tasks, the alarm and the possible date change would be perfect, then I will stop filling your inbox." }
    ]
  }
]
```

### §5.4 `scripts/generate_fixtures.mjs` — complete file

```javascript
// OPTIONAL regeneration path for the synthetic fixtures. The committed files in
// fixtures/synthetic/ are the source of truth; this script exists so an operator can
// produce a fresh variant. It needs OPENAI_API_KEY and is NEVER part of the build:
// no test, no work unit and no runtime path depends on it.
//
//   node --experimental-strip-types scripts/generate_fixtures.mjs            # dry run, prints only
//   node --experimental-strip-types scripts/generate_fixtures.mjs --write    # overwrite fixtures
//
// If the generator degrades (no key, provider down) it prints the DegradedResult and
// exits 0 WITHOUT touching any file — a broken regeneration must never damage the
// committed fixtures.
import { writeFileSync } from "node:fs";
import { generateRecords } from "src/data/index.js";

const WRITE = process.argv.includes("--write");

const bookingSchema = {
  type: "object",
  required: ["booking_id", "listing_name", "guest_name", "check_in", "check_out",
             "nights", "payout_eur", "status", "policy_refs", "prior_disputes"],
  properties: {
    booking_id: { type: "string", pattern: "^BK-[0-9]{4}$" },
    listing_id: { type: "string" },
    listing_name: { type: "string" },
    guest_name: { type: "string" },
    check_in: { type: "string" },
    check_out: { type: "string" },
    nights: { type: "integer", minimum: 1, maximum: 14 },
    payout_eur: { type: "number", minimum: 50, maximum: 3000 },
    status: { type: "string", enum: ["confirmed", "cancellation_requested"] },
    policy_refs: { type: "array", items: { type: "string" } },
    prior_disputes: { type: "integer", minimum: 0, maximum: 5 },
    open_issue: { type: ["string", "null"], enum: ["guest_question", "cleaner_dispute", null] },
    cleaner_notes: { type: ["string", "null"] },
    guest_messages: { type: "array", items: { type: "object" } },
  },
};

const result = await generateRecords({
  domain:
    "bookings for an independent short-stay rental host with three listings, including guest message threads about cancellations, instalment requests and checkout cleaning tasks. No real people, addresses or booking references.",
  shape: { kind: "records", schema: bookingSchema, count: 6 },
  watermark: true,
});

if (result.degraded === true) {
  console.error("[fixtures] generator degraded — committed fixtures left untouched:", result.reason);
  process.exit(0);
}

console.log(JSON.stringify(result.batch, null, 2));
if (WRITE) {
  writeFileSync("fixtures/synthetic/bookings.json", JSON.stringify(result.batch, null, 2) + "\n");
  console.log(`[fixtures] wrote ${result.count} records to fixtures/synthetic/bookings.json`);
}
```

## §6 Algorithms

### §6.1 `is_money_related(clause_id, text)`

1. Let `cid = clause_id.strip().lower()`.
2. For each `p` in `MONEY_PREFIXES`: if `cid == p` or `cid.startswith(p + ".")`, return `True`.
3. If `text` is `None` or empty, return `False`.
4. Let `t = text.lower()`. If any entry of `MONEY_TERMS` is a substring of `t`, return `True`.
5. Return `False`.

Against the §5 fixtures this yields: `cancellation.moderate` → True (prefix),
`payments.installments` → True (prefix), `cleaning.checkout_tasks` → True (the word "charge"
appears in the modified text), `safety.co_alarm` → False.

### §6.2 `diff_snapshots(previous, latest)`

1. Build `prev = {c["clause_id"]: c for c in previous["clauses"]}` and
   `curr = {c["clause_id"]: c for c in latest["clauses"]}`.
2. Create an empty list `out`.
3. For each `cid` in `sorted(set(prev) | set(curr))`:
   1. `p = prev.get(cid)`, `c = curr.get(cid)`.
   2. If `p` is None: append a `ClauseChange` with `change_kind="added"`,
      `previous_text=None`, `latest_text=c["text"]`, `title=c["title"]`.
   3. Else if `c` is None: append with `change_kind="removed"`,
      `previous_text=p["text"]`, `latest_text=None`, `title=p["title"]`.
   4. Else if `p["text"].strip() != c["text"].strip()`: append with
      `change_kind="modified"`, `previous_text=p["text"]`, `latest_text=c["text"]`,
      `title=c["title"]`.
   5. Else: append nothing.
   6. For every appended entry set
      `money_related=is_money_related(cid, latest_text or previous_text)`.
4. Return `out` (already sorted by `clause_id` because step 3 iterates a sorted set).

### §6.3 `affected_bookings(bookings, changes)`

1. Let `changed_ids = {ch["clause_id"] for ch in changes}`.
2. Create an empty list `out`.
3. For each `b` in `bookings` (input order preserved):
   1. `matched = sorted(set(b["policy_refs"]) & changed_ids)`.
   2. `reasons = [f"policy_change:{cid}" for cid in matched]`.
   3. If `b["open_issue"]` is not None: append `f"open_issue:{b['open_issue']}"` to `reasons`.
   4. If `b["status"] == "cancellation_requested"`: append `"status:cancellation_requested"`.
   5. If `matched` is empty AND `b["open_issue"]` is None: continue (skip this booking).
   6. Append `{"booking": b, "matched_clause_ids": matched, "reasons": sorted(reasons)}`.
4. Return `out`.

Against the §5 fixtures the result is exactly, in this order:

| booking | matched_clause_ids | reasons |
|---|---|---|
| BK-1042 | `cancellation.moderate`, `payments.installments` | `open_issue:guest_question`, `policy_change:cancellation.moderate`, `policy_change:payments.installments` |
| BK-1043 | `cleaning.checkout_tasks` | `open_issue:cleaner_dispute`, `policy_change:cleaning.checkout_tasks` |
| BK-1044 | `cancellation.moderate` | `open_issue:guest_question`, `policy_change:cancellation.moderate`, `status:cancellation_requested` |
| BK-1047 | `cleaning.checkout_tasks` | `open_issue:guest_question`, `policy_change:cleaning.checkout_tasks` |

BK-1045 and BK-1046 are omitted → `2 skipped`.

### §6.4 `load_snapshots` file walk

1. `d = fixtures_path(fixtures_dir) / "policy_snapshots"`.
2. If `d` is not a directory: print
   `[stayquiet] policy snapshots directory {d} not found; policy watching disabled` to stderr and
   return `[]`.
3. For each path in `sorted(d.glob("*.json"))`: read and `json.loads` it; on any exception print
   `[stayquiet] snapshot {path.name} unreadable ({err}); skipped` and continue.
4. Drop any object whose `synthetic` is not `True`, with the warning
   `[stayquiet] snapshot {path.name} is not marked synthetic; skipped`.
5. Return the surviving list sorted by `captured_at` ascending
   (`sorted(items, key=lambda s: s["captured_at"])`).

### §6.5 `thread_messages(booking)`

1. `role_of = {"host": "assistant"}`; every other sender maps to `"user"`.
2. Return `[{"role": role_of.get(m["sender"], "user"), "content": m["text"]} for m in
   booking["guest_messages"]]`, order preserved.

## §7 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| `bookings.json` missing/corrupt | `load_bookings()` returns `[]`; the cycle finds nothing to do | stderr warning; the UI shows "0 bookings scanned" rather than an error page |
| `policy_snapshots/` has fewer than two snapshots | no diff is possible; the caller (DP-AGENT) treats `changes` as `[]` and works only on open issues | stderr warning; the run still produces drafts for bookings with open issues |
| One snapshot file is corrupt | that file is skipped; the diff uses the remaining newest two | one stderr line per skipped file |
| A record is not marked `synthetic: true` | it is dropped | stderr warning — this guard is deliberate, so a real record can never enter the demo (SQ-N-03) |
| `scripts/generate_fixtures.mjs` degrades | nothing — committed fixtures are untouched | the printed `DegradedResult` reason; exit code 0 |

## §8 Work units

### WU-DATA-01 — Fixtures committed

**Goal.** Put the three synthetic data files in place, exactly as written in §5.

**Steps.**
1. Create the directories `fixtures/synthetic/` and `fixtures/synthetic/policy_snapshots/`.
2. Write `fixtures/synthetic/policy_snapshots/2026-08-01.json` with the literal contents of §5.1.
3. Write `fixtures/synthetic/policy_snapshots/2026-09-08.json` with the literal contents of §5.2.
4. Write `fixtures/synthetic/bookings.json` with the literal contents of §5.3.
5. Do not reformat, re-order, rename or "improve" any value — later plans, the demo script and the
   video's fact ledger all quote these exact numbers and names.

**Files created.** the three JSON files above.

**Verification command.**
```bash
python -c "
import json
b = json.load(open('fixtures/synthetic/bookings.json', encoding='utf-8'))
s1 = json.load(open('fixtures/synthetic/policy_snapshots/2026-08-01.json', encoding='utf-8'))
s2 = json.load(open('fixtures/synthetic/policy_snapshots/2026-09-08.json', encoding='utf-8'))
print(len(b), all(x['synthetic'] is True for x in b), len(s1['clauses']), len(s2['clauses']), len(b[5]['guest_messages']))
"
```
**Expected output.**
```
6 True 6 7 14
```
**What it proves.** Six synthetic bookings, both snapshots parse, the newer one has the added
clause, and the long thread the context buffer will truncate is present.

---

### WU-DATA-02 — Loaders

**Goal.** `load_bookings()` and `load_snapshots()` read the fixtures through the config surface.

**Steps.**
1. Create `src/stayquiet/seed.py` with the imports, constants and TypedDicts of §3 verbatim.
2. Implement `fixtures_path()`, `load_bookings()`, `load_snapshots()` per §3's docstrings and
   §6.4. `fixtures_path` resolves a relative directory against `repo_root()`.
3. Implement `find_booking()` and `thread_messages()` per §3 and §6.5.

**Files created.** `src/stayquiet/seed.py` (partial — §6.1–§6.3 land in WU-03).

**Verification command.**
```bash
python -c "
from src.stayquiet.seed import load_bookings, load_snapshots, find_booking, thread_messages
b = load_bookings(); s = load_snapshots()
print(len(b), [x['captured_at'] for x in s], find_booking('BK-1044')['guest_name'], len(thread_messages(find_booking('BK-1047'))))
"
```
**Expected output.**
```
6 ['2026-08-01', '2026-09-08'] Anneli Virtanen 14
```
**What it proves.** The loaders resolve the fixtures directory from `AppConfig` (a real
DP-FOUND → DP-DATA import), return snapshots oldest-first, and convert a thread to the buffer's
message shape.

---

### WU-DATA-03 — Deterministic diff and money classification

**Goal.** `diff_snapshots()` and `is_money_related()` per §6.1–§6.2.

**Steps.**
1. Add `is_money_related()` implementing §6.1 exactly.
2. Add `diff_snapshots()` implementing §6.2 exactly.
3. Do not call any model, do not use `random`, do not read the clock.

**Files modified.** `src/stayquiet/seed.py`.

**Verification command.**
```bash
python -c "
from src.stayquiet.seed import load_snapshots, diff_snapshots
s = load_snapshots(); ch = diff_snapshots(s[-2], s[-1])
print(len(ch))
for c in ch: print(c['clause_id'], c['change_kind'], c['money_related'])
"
```
**Expected output.**
```
4
cancellation.moderate modified True
cleaning.checkout_tasks modified True
payments.installments modified True
safety.co_alarm added False
```
**What it proves.** The diff is clause-level, sorted, correctly typed, and the money flag is
deterministic — the exact four rows the video's fact ledger will quote.

---

### WU-DATA-04 — Impact matching

**Goal.** `affected_bookings()` per §6.3.

**Steps.**
1. Add `affected_bookings()` implementing §6.3 exactly.
2. Do not add a triage, severity or escalation decision here — DP-AGENT owns that.

**Files modified.** `src/stayquiet/seed.py`.

**Verification command.**
```bash
python -c "
from src.stayquiet.seed import load_bookings, load_snapshots, diff_snapshots, affected_bookings
bk = load_bookings(); s = load_snapshots()
imp = affected_bookings(bk, diff_snapshots(s[-2], s[-1]))
print(f'{len(imp)} of {len(bk)} affected, {len(bk)-len(imp)} skipped')
for i in imp: print(i['booking']['booking_id'], ','.join(i['matched_clause_ids']))
"
```
**Expected output.**
```
4 of 6 affected, 2 skipped
BK-1042 cancellation.moderate,payments.installments
BK-1043 cleaning.checkout_tasks
BK-1044 cancellation.moderate
BK-1047 cleaning.checkout_tasks
```
**What it proves.** Only bookings a changed clause actually touches (or with an open issue) are
selected, in fixture order, with the exact counts the demo narrates (SQ-F-03).

---

### WU-DATA-05 — Optional regeneration script

**Goal.** Give the operator a regeneration path without making the build depend on it.

**Steps.**
1. Create `scripts/generate_fixtures.mjs` with the literal contents of §5.4.
2. Do not run it against the real fixtures. Do not add it to `package.json` scripts.

**Files created.** `scripts/generate_fixtures.mjs`.

**Verification command.**
```bash
node --check scripts/generate_fixtures.mjs && python -c "
import json; print(len(json.load(open('fixtures/synthetic/bookings.json', encoding='utf-8'))))
"
```
**Expected output.**
```
6
```
**What it proves.** The script is syntactically valid JavaScript and the committed fixtures were
not overwritten by adding it.

---

## §9 Verification summary

```bash
# WU-DATA-01
python -c "
import json
b=json.load(open('fixtures/synthetic/bookings.json',encoding='utf-8'))
s1=json.load(open('fixtures/synthetic/policy_snapshots/2026-08-01.json',encoding='utf-8'))
s2=json.load(open('fixtures/synthetic/policy_snapshots/2026-09-08.json',encoding='utf-8'))
print(len(b), all(x['synthetic'] is True for x in b), len(s1['clauses']), len(s2['clauses']), len(b[5]['guest_messages']))"
# WU-DATA-02
python -c "
from src.stayquiet.seed import load_bookings, load_snapshots, find_booking, thread_messages
b=load_bookings(); s=load_snapshots()
print(len(b), [x['captured_at'] for x in s], find_booking('BK-1044')['guest_name'], len(thread_messages(find_booking('BK-1047'))))"
# WU-DATA-03
python -c "
from src.stayquiet.seed import load_snapshots, diff_snapshots
s=load_snapshots(); ch=diff_snapshots(s[-2], s[-1]); print(len(ch))
[print(c['clause_id'], c['change_kind'], c['money_related']) for c in ch]"
# WU-DATA-04
python -c "
from src.stayquiet.seed import load_bookings, load_snapshots, diff_snapshots, affected_bookings
bk=load_bookings(); s=load_snapshots(); imp=affected_bookings(bk, diff_snapshots(s[-2], s[-1]))
print(f'{len(imp)} of {len(bk)} affected, {len(bk)-len(imp)} skipped')
[print(i['booking']['booking_id'], ','.join(i['matched_clause_ids'])) for i in imp]"
# WU-DATA-05
node --check scripts/generate_fixtures.mjs && python -c "import json; print(len(json.load(open('fixtures/synthetic/bookings.json',encoding='utf-8'))))"
```

## §10 Risks

| Risk | Mitigation |
|---|---|
| An implementor "tidies" the fixtures and the demo numbers change | WU-01 step 5 forbids it; four later verification commands assert the exact counts `4 of 6 affected, 2 skipped` and the four diff rows, so any edit fails immediately |
| Someone puts the escalation rule in `seed.py` because it feels like data logic | §2 OUT and WU-04 step 2 name DP-AGENT as the owner; `seed.py` has no `Decision` type to write into |
| The money-keyword rule flags something unexpected | the rule is fully enumerated in §6.1 and its result on every shipped clause is tabulated there, so the behaviour is checkable by reading, not by running |
| A regenerated fixture set breaks the diff expectations | `scripts/generate_fixtures.mjs` is dry-run by default and no work unit runs it; regenerating is an operator choice that requires re-measuring the demo (DP-SCRIPT says so explicitly) |
| Guest names accidentally resemble real people | all six are invented from common given/family names with no real listing, address, contact detail or reference; every record is stamped `synthetic: true` and the loader drops anything that is not |
