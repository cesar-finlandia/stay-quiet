# DP-STREAM — Envelope emission, run and decision state, audit trail

## §0 Context & blockers

Must already exist (produced by **DP-FOUND**):

* `src/stayquiet/config.py` exporting `AppConfig`, `load_app_config()`, `repo_root()`.
* `src/stayquiet/__init__.py`.
* `requirements.txt` installed (`jsonschema` is used here).

Pre-existing and read-only: `src/platform/transport/event_envelope.py` (the generated envelope
type), `contracts/event-envelope.schema.json` (the envelope schema).

**Contract note — `contracts/event-envelope.schema.json` is at v1.1.0.** Its v1.0.0 `step_id`
pattern was `^[a-z0-9]+(-[a-z0-9]+)*$`, kebab-case only, which rejected every id in the §3.1
vocabulary. The pattern is now `^[a-z0-9]+([-_][a-z0-9]+)*$`, accepting `-` or `_` as the word
separator. This is a MINOR widening: every id valid under v1.0.0 is still valid, uppercase, spaces,
leading, trailing and doubled separators are still rejected, and the field's own description says it
carries no semantics. The rationale, and the confirmation that no consumer depended on the
restriction, are recorded in the file's `$comment`. Do not narrow it back, and do not work around it
by rewriting ids inside `emit()` — DP-AGENT, DP-API and DP-UI all assert the underscore ids
literally.

Not needed and deliberately unused: `src/platform/transport/stream_router.py`. Its own header says
`ILLUSTRATIVE WIRING`, and its `publish()` is `async`, which cannot be called from the synchronous
agent loop. This plan exposes `since()` instead and DP-API polls it.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Own the three pieces of state the product has: the stream of what the agent is doing, the runs and
decisions the host acts on, and the append-only audit trail.

Requirements (blueprint §1): **SQ-F-07** (one decision ping with approve/edit, resolution written
to the audit trail), **SQ-F-08** (append-only audit trail of every action, fallback and human
decision, readable in the UI and on disk), **SQ-F-10** (every step streams as a typed
`EventEnvelope`), **SQ-N-05** (degraded states are visible, labelled and non-blocking).

## §2 Scope boundaries

### IN — the only files this plan creates

1. `src/stayquiet/publish.py`
2. `src/stayquiet/store.py`
3. `src/stayquiet/audit.py`

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `config/stayquiet.json`, `src/stayquiet/config.py` | DP-FOUND |
| `src/stayquiet/seed.py` | DP-DATA |
| `src/stayquiet/model.py`, `src/stayquiet/context_bridge.py` | DP-MODEL |
| `engine/tools/**` | DP-TOOLS |
| `engine/agents/**` | DP-AGENT |
| `src/stayquiet/api.py`, the SSE route, the REST routes | DP-API |
| `src/stayquiet/web/**` | DP-UI |
| `src/platform/transport/**` | pre-existing — read-only |
| `contracts/event-envelope.schema.json` | pre-existing; already amended to v1.1.0 per §0 — do not edit it again |

None of these three files may import from `engine/`, may call a model, or may decide *whether* a
booking is escalated. `store.py` records decisions; DP-AGENT decides them.

## §3 Interfaces owned

### 3.1 `src/stayquiet/publish.py`

```python
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
#: contracts/event-envelope.schema.json v1.1.0 accepts them (see §0).
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


def new_trace_id() -> str:
    """A fresh trace id for one cycle or one API action (uuid4 as a string)."""


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


def envelopes(trace_id: str | None = None) -> list[dict]:
    """Every envelope currently in the ring, sequence-sorted. Filtered to one
    trace when `trace_id` is given. Returns a copy — callers may mutate it."""


def since(sequence: int, trace_id: str | None = None) -> list[dict]:
    """Every envelope whose `sequence` is greater than `sequence`, sequence-sorted.

    This is the SSE route's only read path (DP-API polls it). Filtered to one trace
    when `trace_id` is given. Returns a copy.
    """


def snapshot(trace_id: str | None = None) -> dict:
    """The GET /events fallback body (blueprint §2.3).

    Returns {"status": "complete", "trace_id": str, "events": list[dict],
             "degraded": bool} where `degraded` is True if any included envelope
    has degraded True. `trace_id` defaults to the newest envelope's trace, or "" if
    the ring is empty.
    """


def latest_sequence() -> int:
    """The highest sequence assigned so far; 0 before the first emit."""


def reset() -> None:
    """Clear the ring and reset the sequence to 0. Tests and the recording script
    only — the API never calls it."""
```

### 3.2 `src/stayquiet/store.py`

```python
# StayQuiet — the ONLY owner of run and decision state (blueprint §2.4 rows 23-25,
# §2.4c rule 5). In-process, lock-guarded, no database (a hackathon demo has one
# host and one process). The agent creates runs and decisions; the API reads them
# and resolves them.
from __future__ import annotations

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


def create_run(trace_id: str) -> RunRecord:
    """Open a run in status "running" with zeroed counters. Never raises."""


def finish_run(run_id: str, **fields) -> Optional[RunRecord]:
    """Set finished_at and merge the given fields into the run.

    Accepted field names are exactly the RunRecord keys other than run_id,
    trace_id and started_at; anything else is ignored with one stderr warning.
    Returns the updated record, or None when run_id is unknown. Never raises.
    """


def get_run(run_id: str) -> Optional[RunRecord]:
    """One run by id, or None."""


def latest_run() -> Optional[RunRecord]:
    """The most recently created run, or None when none has run yet."""


def list_runs(limit: int = 20) -> list[RunRecord]:
    """Newest first, at most `limit`."""


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


def list_decisions(status: str | None = None) -> list[Decision]:
    """Newest first. Filtered by status when given ("pending"/"approved"/"edited")."""


def get_decision(decision_id: str) -> Optional[Decision]:
    """One decision by id, or None."""


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


def reset() -> None:
    """Clear all runs and decisions. Tests only."""
```

### 3.3 `src/stayquiet/audit.py`

```python
# StayQuiet — the ONLY writer of the audit trail (blueprint §2.4 row 26,
# §2.4c rule 4). Append-only JSON Lines on disk plus an in-memory mirror, so a
# dispute can be defended from the file and the UI can render it without I/O.
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

from src.stayquiet.config import repo_root

#: The audit file, relative to the repository root. One JSON object per line.
AUDIT_PATH: Path = repo_root() / "fixtures" / "audit" / "audit.jsonl"


class AuditEntry(TypedDict):
    """One immutable line of the audit trail."""

    entry_id: str      # "AUD-<8 hex>"
    at: str            # ISO-8601 UTC
    action: str        # short verb phrase, e.g. "draft_prepared"
    booking_id: str    # "" when the action is not booking-specific
    detail: str        # one sentence a human can read in a dispute
    trace_id: str
    degraded: bool


def audit_append(
    action: str,
    booking_id: str,
    detail: str,
    *,
    trace_id: str,
    degraded: bool = False,
) -> AuditEntry:
    """Append one entry to the trail and return it.

    Creates the parent directory on first use. A file-system failure is warned to
    stderr and the entry is still added to the in-memory mirror, so the UI never
    loses the trail because the disk is read-only. Never raises.
    """


def audit_read(limit: int = 200) -> list[AuditEntry]:
    """The newest `limit` entries, newest first.

    Reads the in-memory mirror when it is populated; otherwise reads AUDIT_PATH
    line by line, skipping unparsable lines with one stderr warning per file read.
    Never raises.
    """


def audit_reset() -> None:
    """Clear the in-memory mirror and delete AUDIT_PATH. Tests and the recording
    script only."""
```

## §4 Interfaces consumed

Copy verbatim:

```python
from src.platform.transport.event_envelope import EventEnvelope  # pre-existing platform/transport (frozen envelope type)
from src.stayquiet.config import repo_root                       # owned by DP-FOUND
```

Nothing else. In particular: no `seed.py`, no `model.py`, no `engine.*`, no
`stream_router`.

## §5 Algorithms

### §5.1 `emit(step_id, status, payload, *, trace_id, degraded)`

Module state: `_lock = threading.Lock()`, `_ring: list[dict] = []`, `_seq = 0`.

1. If `step_id` not in `STEP_IDS`: print
   `[stayquiet] unknown step_id "{step_id}" — the vocabulary is: {', '.join(STEP_IDS)}` to stderr.
   Continue anyway.
2. If `status` not in `STATUSES`: print the same style of warning naming `STATUSES`, then set
   `status = "streaming"` so the envelope still validates against the frozen schema.
3. Make the payload safe: `try: json.dumps(payload)` — on `TypeError`/`ValueError` replace it with
   `{"unserializable": repr(payload)[:500]}`. A `payload` that is not a dict at all becomes
   `{"value": <the json-safe form>}`.
4. Under `_lock`:
   1. `_seq += 1`
   2. Build the envelope:
      ```python
      env = {
          "step_id": str(step_id),
          "status": status,
          "payload": safe_payload,
          "timestamp": datetime.now(timezone.utc).isoformat(),
          "sequence": _seq,
          "trace_id": str(trace_id),
          "degraded": bool(degraded),
      }
      ```
   3. `_ring.append(env)`; while `len(_ring) > RING_CAPACITY`: `_ring.pop(0)`.
5. Return `env`.
6. The whole body is inside `try/except Exception`; on an internal failure print
   `[stayquiet] emit failed ({err})` and return a minimal envelope with `status: "error"`,
   `sequence: 0` and `payload: {"emit_error": str(err)}` — a broken emit must never stop a cycle.

Note on the `degraded` key: the envelope schema marks it `NotRequired`, and the UI's
`isDegradedEnvelope()` checks `degraded === true`, so always writing an explicit boolean is
correct and keeps the SSE payload self-describing.

### §5.2 `envelopes` / `since` / `snapshot` / `latest_sequence`

* `envelopes(trace_id)`: under `_lock`, copy `_ring`; if `trace_id` is not None filter on
  `env["trace_id"] == trace_id`; return `sorted(items, key=lambda e: e["sequence"])`.
* `since(sequence, trace_id)`: as above but filter `env["sequence"] > sequence` first.
* `latest_sequence()`: under `_lock`, return `_seq`.
* `snapshot(trace_id)`:
  1. `items = envelopes(trace_id)`.
  2. If `trace_id` is None: `tid = items[-1]["trace_id"] if items else ""`; else `tid = trace_id`.
  3. Return `{"status": "complete", "trace_id": tid, "events": items,
     "degraded": any(e.get("degraded") is True for e in items)}`.

### §5.3 `store.py` state and id generation

Module state: `_lock = threading.Lock()`, `_runs: dict[str, RunRecord] = {}`,
`_run_order: list[str] = []`, `_decisions: dict[str, Decision] = {}`,
`_decision_order: list[str] = []`.

* Run id: `"RUN-" + uuid.uuid4().hex[:8]`. Decision id: `"DEC-" + uuid.uuid4().hex[:8]`.
* `_now()` returns `datetime.now(timezone.utc).isoformat()`.
* `create_run(trace_id)`:
  1. Under `_lock`: build the record with `status="running"`, `started_at=_now()`,
     `finished_at=None`, all counters `0`, `changed_clauses=[]`, `decisions=[]`,
     `degraded=False`, `summary=""`.
  2. Store it, append the id to `_run_order`, return the record.
* `finish_run(run_id, **fields)`:
  1. Allowed keys: `status`, `bookings_scanned`, `bookings_affected`, `changed_clauses`,
     `decisions`, `quiet_actions`, `degraded`, `elapsed_ms`, `tokens`, `summary`.
  2. Under `_lock`: look the run up (return `None` if absent); set `finished_at = _now()`; for
     each allowed key present in `fields`, assign it; warn once per rejected key.
  3. If `status` was not supplied, leave it as it is — the caller decides `done` vs `error`.
* `add_decision(...)`:
  1. `factor = EXPOSURE_FACTOR.get(kind)`; if `None`, warn
     `[stayquiet] unknown decision kind "{kind}"; using exposure factor 0.25` and use `0.25`.
  2. `exposure = round(float(payout_eur) * factor, 2)`.
  3. Under `_lock`: build the `Decision` with `status="pending"`, `created_at=_now()`,
     `resolved_at=None`, `final_text=None`; store it; append the id to `_decision_order`; if
     `run_id` is a known run, append the decision id to that run's `decisions` list.
  4. Return the decision.
* `list_decisions(status)`: under `_lock`, walk `_decision_order` reversed, filter on status when
  given, return copies.
* `resolve_decision(decision_id, action, edited_text)`:
  1. Under `_lock`: `d = _decisions.get(decision_id)`; return `None` if absent.
  2. If `d["status"] != "pending"`: return `d` unchanged (idempotent).
  3. If `action == "approve"`: `d["status"] = "approved"`; `d["final_text"] = d["draft_text"]`.
  4. Else if `action == "edit"`: if `edited_text` is None or `edited_text.strip() == ""`, return
     `None`; else `d["status"] = "edited"`; `d["final_text"] = edited_text`.
  5. Else: return `None`.
  6. `d["resolved_at"] = _now()`; return `d`.

Writing the audit line for a resolution is **DP-API's** job, not `store.py`'s — `store.py` has no
audit import.

### §5.4 `audit_append` / `audit_read`

Module state: `_lock = threading.Lock()`, `_mirror: list[AuditEntry] = []`.

* `audit_append(action, booking_id, detail, *, trace_id, degraded)`:
  1. Build `entry = {"entry_id": "AUD-" + uuid.uuid4().hex[:8], "at": _now(),
     "action": str(action), "booking_id": str(booking_id or ""), "detail": str(detail),
     "trace_id": str(trace_id), "degraded": bool(degraded)}`.
  2. Under `_lock`: append to `_mirror`.
  3. Try: `AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)`, then open `AUDIT_PATH` in
     `"a"` mode with `encoding="utf-8"` and write `json.dumps(entry, ensure_ascii=False) + "\n"`.
     On any `OSError`, print `[stayquiet] audit file not writable ({err}); keeping the trail in
     memory only` at most once per process (guard with a module flag).
  4. Return `entry`.
* `audit_read(limit)`:
  1. Under `_lock`: if `_mirror` is non-empty, `items = list(_mirror)`.
  2. Else try reading `AUDIT_PATH` line by line, `json.loads` each, skipping bad lines and warning
     once with the count of skipped lines. A missing file yields `[]`.
  3. Return `list(reversed(items))[:limit]`.
* `audit_reset()`: clear `_mirror`; `AUDIT_PATH.unlink(missing_ok=True)` inside try/except.

Add `fixtures/audit/` to nothing — the directory is created at runtime, and the file is a runtime
artifact. Add exactly this line to `.gitignore` in WU-STREAM-03: `fixtures/audit/`.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| A typo'd `step_id` is emitted | nothing — the envelope is still delivered | a stderr warning naming the closed vocabulary; the UI shows the raw id instead of a friendly label |
| A payload is not JSON-serializable | that payload only | `{"unserializable": "<repr>"}` in the envelope; the run continues |
| The ring fills | oldest envelopes are dropped | a very long session loses early history from the UI; the audit trail on disk is unaffected |
| `fixtures/audit/` is read-only (e.g. a hardened container) | on-disk trail only | one warning; the UI still shows the full trail from the in-memory mirror |
| The process restarts | runs, decisions and the ring are lost | the UI shows an empty monitor until the next cycle; the on-disk audit trail survives and is re-read |
| `resolve_decision` called twice | nothing | the second call returns the already-resolved decision unchanged |

## §7 Work units

### WU-STREAM-01 — Envelope emission

**Goal.** One monotonic, schema-shaped envelope stream that synchronous code can write to.

**Steps.**
1. Create `src/stayquiet/publish.py` with §3.1's skeleton verbatim.
2. Implement `new_trace_id`, `emit` (§5.1), `envelopes`, `since`, `snapshot`, `latest_sequence`,
   `reset` (§5.2).
3. Do not add an `async def` anywhere in this file.

**Files created.** `src/stayquiet/publish.py`.

**Verification command.**
```bash
python -c "
import json, jsonschema
from src.stayquiet.publish import emit, new_trace_id, envelopes, since, snapshot, reset
reset()
t = new_trace_id()
emit('cycle', 'started', {'run': 1}, trace_id=t)
emit('policy_diff', 'done', {'changed': 4}, trace_id=t)
emit('draft_reply', 'done', {'booking_id': 'BK-1044'}, trace_id=t, degraded=True)
schema = json.load(open('contracts/event-envelope.schema.json', encoding='utf-8'))
for e in envelopes(t): jsonschema.validate(e, schema)
print([e['sequence'] for e in envelopes(t)], len(since(1, t)), snapshot(t)['degraded'], snapshot(t)['status'])
"
```
**Expected output.**
```
[1, 2, 3] 2 True complete
```
**What it proves.** Every envelope validates against `contracts/event-envelope.schema.json`
(v1.1.0 — see the contract note in §0), `sequence` is monotonic, `since()` returns only newer
envelopes, and the fallback snapshot reports degraded correctly.

Run this too, once: it validates every id in the closed vocabulary rather than the three this work
unit happens to emit, so a future addition to `STEP_IDS` cannot slip past the schema.

```bash
python -c "
import json, jsonschema
from src.stayquiet.publish import STEP_IDS, emit, new_trace_id, envelopes, reset
reset(); t=new_trace_id()
for s in STEP_IDS: emit(s,'done',{},trace_id=t)
schema=json.load(open('contracts/event-envelope.schema.json',encoding='utf-8'))
[jsonschema.validate(e,schema) for e in envelopes(t)]
print('validated', len(STEP_IDS), 'ids')"
```

Expected: `validated 12 ids`.

---

### WU-STREAM-02 — Run and decision state

**Goal.** The state the host acts on, with the modelled-exposure formula in exactly one place.

**Steps.**
1. Create `src/stayquiet/store.py` with §3.2's skeleton verbatim.
2. Implement everything per §5.3.
3. Do not import `audit.py` here.

**Files created.** `src/stayquiet/store.py`.

**Verification command.**
```bash
python -c "
from src.stayquiet.store import (create_run, finish_run, add_decision, list_decisions,
                                 resolve_decision, latest_run, reset)
reset()
r = create_run('trace-1')
d = add_decision(run_id=r['run_id'], trace_id='trace-1', booking_id='BK-1044',
                 guest_name='Anneli Virtanen', listing_name='Harbour Studio', kind='refund',
                 summary='Refund window changed', clause_ids=['cancellation.moderate'],
                 draft_text='Proposed reply', checklist=[], payout_eur=395.0)
print(d['decision_id'][:4], d['kind'], d['modelled_exposure_eur'], d['status'])
print(resolve_decision(d['decision_id'], 'edit', 'My own wording')['status'])
print(resolve_decision(d['decision_id'], 'approve')['final_text'])
print(resolve_decision('DEC-nope', 'approve'), len(list_decisions('edited')))
finish_run(r['run_id'], status='done', bookings_scanned=6, bookings_affected=4, tokens=4321)
lr = latest_run(); print(lr['status'], lr['bookings_affected'], len(lr['decisions']))
"
```
**Expected output.**
```
DEC- refund 395.0 pending
edited
My own wording
None 1
done 4 1
```
**What it proves.** The exposure formula produces the exact figure the demo quotes for BK-1044,
resolution is idempotent, an unknown id returns `None` instead of raising, and the run aggregates
its decisions.

---

### WU-STREAM-03 — Audit trail

**Goal.** An append-only trail on disk and in memory that survives a read-only filesystem.

**Steps.**
1. Create `src/stayquiet/audit.py` with §3.3's skeleton verbatim and §5.4's algorithms.
2. Append the single line `fixtures/audit/` to `.gitignore` (runtime artifact; the trail is
   regenerated on every run and must not be committed).
3. Do not import `store.py` or `publish.py` here.

**Files created/modified.** `src/stayquiet/audit.py`, `.gitignore`.

**Verification command.**
```bash
python -c "
from src.stayquiet.audit import audit_append, audit_read, audit_reset, AUDIT_PATH
audit_reset()
audit_append('policy_change_detected', '', 'Three clauses changed between 2026-08-01 and 2026-09-08.', trace_id='t1')
audit_append('draft_prepared', 'BK-1044', 'Reply drafted from the current moderate cancellation clause.', trace_id='t1')
audit_append('served_from_cache', 'BK-1047', 'Bedrock unavailable; used the recorded reply.', trace_id='t1', degraded=True)
rows = audit_read()
print(len(rows), rows[0]['action'], rows[0]['degraded'], AUDIT_PATH.exists())
print(sum(1 for line in open(AUDIT_PATH, encoding='utf-8')))
" && grep -c "^fixtures/audit/$" .gitignore
```
**Expected output.**
```
3 served_from_cache True True
3
1
```
**What it proves.** Entries are appended in order, read back newest-first with the degraded flag
intact, persisted as one JSON object per line for dispute defence, and the runtime directory is
git-ignored.

---

## §8 Verification summary

```bash
# WU-STREAM-01
python -c "
import json, jsonschema
from src.stayquiet.publish import emit, new_trace_id, envelopes, since, snapshot, reset
reset(); t=new_trace_id()
emit('cycle','started',{'run':1},trace_id=t)
emit('policy_diff','done',{'changed':4},trace_id=t)
emit('draft_reply','done',{'booking_id':'BK-1044'},trace_id=t,degraded=True)
schema=json.load(open('contracts/event-envelope.schema.json',encoding='utf-8'))
[jsonschema.validate(e,schema) for e in envelopes(t)]
print([e['sequence'] for e in envelopes(t)], len(since(1,t)), snapshot(t)['degraded'], snapshot(t)['status'])"
# WU-STREAM-02
python -c "
from src.stayquiet.store import create_run, finish_run, add_decision, list_decisions, resolve_decision, latest_run, reset
reset(); r=create_run('trace-1')
d=add_decision(run_id=r['run_id'],trace_id='trace-1',booking_id='BK-1044',guest_name='Anneli Virtanen',
  listing_name='Harbour Studio',kind='refund',summary='Refund window changed',
  clause_ids=['cancellation.moderate'],draft_text='Proposed reply',checklist=[],payout_eur=395.0)
print(d['decision_id'][:4], d['kind'], d['modelled_exposure_eur'], d['status'])
print(resolve_decision(d['decision_id'],'edit','My own wording')['status'])
print(resolve_decision(d['decision_id'],'approve')['final_text'])
print(resolve_decision('DEC-nope','approve'), len(list_decisions('edited')))
finish_run(r['run_id'],status='done',bookings_scanned=6,bookings_affected=4,tokens=4321)
lr=latest_run(); print(lr['status'], lr['bookings_affected'], len(lr['decisions']))"
# WU-STREAM-03
python -c "
from src.stayquiet.audit import audit_append, audit_read, audit_reset, AUDIT_PATH
audit_reset()
audit_append('policy_change_detected','','Three clauses changed between 2026-08-01 and 2026-09-08.',trace_id='t1')
audit_append('draft_prepared','BK-1044','Reply drafted from the current moderate cancellation clause.',trace_id='t1')
audit_append('served_from_cache','BK-1047','Bedrock unavailable; used the recorded reply.',trace_id='t1',degraded=True)
rows=audit_read(); print(len(rows), rows[0]['action'], rows[0]['degraded'], AUDIT_PATH.exists())
print(sum(1 for line in open(AUDIT_PATH,encoding='utf-8')))" && grep -c "^fixtures/audit/$" .gitignore
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| An implementor reaches for the illustrative `stream_router.HUB` and hits async-from-sync | §0 and §2 both name it as unused and say why; `publish.py` contains no `async def` and WU-01 forbids adding one |
| Two writers assign `sequence` and the UI mis-orders the run | `emit()` is the only writer, under a lock; `useEventStream` sorts by sequence anyway |
| The exposure formula gets duplicated in the agent or the UI | it lives only in `store.py:add_decision` via `EXPOSURE_FACTOR`; DP-AGENT passes `payout_eur` and a `kind`, nothing else |
| A read-only container filesystem kills the audit trail and the demo | the in-memory mirror is authoritative for the UI; the disk write is best-effort and warns once |
| Someone writes the resolution audit line inside `store.py`, duplicating DP-API's | §5.3 states plainly that DP-API owns it and `store.py` has no audit import |
| Unbounded memory growth over a long judging period | `RING_CAPACITY` caps the ring; runs and decisions are small dicts and a judging session creates a handful |
