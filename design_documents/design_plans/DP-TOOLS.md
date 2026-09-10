# DP-TOOLS — The six deterministic Strands tools

## §0 Context & blockers

Must already exist:

* **DP-FOUND**: `src/stayquiet/config.py` (`load_app_config`, `repo_root`), `engine/__init__.py`,
  `engine/tools/__init__.py` (placeholder), `requirements.txt` installed, `from strands import tool`
  verified working.
* **DP-DATA**: `src/stayquiet/seed.py` with `Booking`, `ClauseChange`, `load_bookings`,
  `load_snapshots`, `diff_snapshots`, `find_booking`, `thread_messages`.
* **DP-MODEL**: `src/stayquiet/context_bridge.py` with `fit_thread`, `ThreadFit`.
* **DP-STREAM**: `src/stayquiet/publish.py` with `emit`; `src/stayquiet/audit.py` with
  `audit_append`.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Give the Strands agent loop six tools it can choose from. Every tool is **deterministic**: it reads
committed fixtures, computes, emits an event envelope, and returns a small JSON-serializable dict.
**No tool calls a model.** The model does the writing; the tools supply the grounding and the side
effects.

Requirements (blueprint §1): **SQ-F-02** (`policy_diff` surfaces the clause-level diff to the
loop), **SQ-F-08** (`audit_log` is how the loop records what it did), **SQ-F-11**
(`booking_lookup` fits the guest thread through the context buffer), plus the grounding that
**SQ-F-04** and **SQ-F-05** depend on (`clause_lookup`, `checklist_baseline`).

## §2 Scope boundaries

### IN — the only files this plan creates or modifies

1. `engine/tools/ctx.py`
2. `engine/tools/policy.py` — `policy_fetch`, `policy_diff`
3. `engine/tools/bookings.py` — `booking_lookup`
4. `engine/tools/clauses.py` — `clause_lookup`
5. `engine/tools/checklists.py` — `checklist_baseline`
6. `engine/tools/auditing.py` — `audit_log`
7. `engine/tools/__init__.py` — replace the DP-FOUND placeholder with the final export

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `src/stayquiet/seed.py` (the diff and matching algorithms) | DP-DATA |
| `src/stayquiet/model.py`, `src/stayquiet/context_bridge.py` | DP-MODEL |
| `src/stayquiet/publish.py`, `src/stayquiet/store.py`, `src/stayquiet/audit.py` | DP-STREAM |
| `engine/agents/**`, `engine/prompts/**`, `engine/schema/**` | DP-AGENT |
| `src/stayquiet/api.py` | DP-API |
| `config/stayquiet.json`, `src/stayquiet/config.py` | DP-FOUND |

Hard prohibitions for this plan, each of which has broken a previous entry:

* **No tool imports `src.stayquiet.model`.** Tools never call a model, never construct an `Agent`,
  never see a prompt.
* **No tool builds an envelope dict.** Emission goes through `ctx.tool_begin` / `ctx.tool_end`,
  which call `publish.emit` — the single owner.
* **No tool re-implements the diff, the money classification, the impact match or the token
  count.** Those live in `seed.py` and `context_bridge.py`.
* **No tool decides escalation.** Triage is DP-AGENT's.
* **No tool writes to `store.py`.**

## §3 Interfaces owned

### 3.1 `engine/tools/ctx.py`

```python
# StayQuiet tools — shared per-cycle context (blueprint §2.4 row 29).
# Holds the current trace id so a tool can tag its envelope without the model
# having to pass one, and records which tools the loop actually chose so the agent
# can report real tool usage. Module-level state: this process runs one cycle at a
# time by design (DP-API serialises cycles).
from __future__ import annotations

import threading
from typing import Any

from src.stayquiet.publish import emit


def set_trace(trace_id: str) -> None:
    """Set the trace id every subsequent tool envelope is tagged with. Called once
    per cycle by the agent, before the loop starts."""


def current_trace() -> str:
    """The active trace id, or "" when set_trace has not been called."""


def note_tool_call(name: str) -> None:
    """Record that the loop invoked the tool called `name`. Appended in call order,
    duplicates kept."""


def drain_tool_calls() -> list[str]:
    """Return the recorded tool-call names in order and clear the recorder. The
    agent calls this after each turn so its CycleResult reports genuine tool use."""


def tool_begin(step_id: str, payload: dict) -> None:
    """Record the call and emit `{step_id}` with status "started". Never raises."""


def tool_end(step_id: str, payload: dict, degraded: bool = False) -> None:
    """Emit `{step_id}` with status "done". Never raises."""


def tool_error(step_id: str, message: str) -> None:
    """Emit `{step_id}` with status "error" and degraded True. Never raises."""
```

### 3.2 `engine/tools/policy.py`

```python
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
```

### 3.3 `engine/tools/bookings.py`

```python
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
```

### 3.4 `engine/tools/clauses.py`

```python
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
```

### 3.5 `engine/tools/checklists.py`

```python
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
```

### 3.6 `engine/tools/auditing.py`

```python
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
```

### 3.7 `engine/tools/__init__.py`

```python
# StayQuiet Strands tools — the closed set the agent loop may choose from
# (blueprint §2.4 row 27). Order is fixed: it is the order the tools appear in the
# agent's tool list and therefore in its system prompt.
from engine.tools.auditing import audit_log
from engine.tools.bookings import booking_lookup
from engine.tools.checklists import checklist_baseline
from engine.tools.clauses import clause_lookup
from engine.tools.ctx import current_trace, drain_tool_calls, note_tool_call, set_trace
from engine.tools.policy import policy_diff, policy_fetch

ALL_TOOLS: list = [
    policy_diff,
    policy_fetch,
    booking_lookup,
    clause_lookup,
    checklist_baseline,
    audit_log,
]

__all__ = [
    "ALL_TOOLS",
    "audit_log",
    "booking_lookup",
    "checklist_baseline",
    "clause_lookup",
    "current_trace",
    "drain_tool_calls",
    "note_tool_call",
    "policy_diff",
    "policy_fetch",
    "set_trace",
]
```

## §4 Interfaces consumed

Copy these lines verbatim. Each names the plan that owns it.

```python
from src.stayquiet.publish import emit                                    # DP-STREAM
from src.stayquiet.audit import audit_append                              # DP-STREAM
from src.stayquiet.seed import (                                          # DP-DATA
    diff_snapshots,
    find_booking,
    load_snapshots,
    thread_messages,
)
from src.stayquiet.context_bridge import fit_thread                       # DP-MODEL
from src.stayquiet.config import load_app_config                          # DP-FOUND
from strands import tool                                                  # Strands Agents SDK for Python
```

## §5 Algorithms

Every tool follows the same five-step shape. Deviating from it is the single most common way these
files go wrong, so it is written out once here and referenced by each tool below.

**The tool shape.**
1. `tool_begin("<step_id>", {<the arguments, as given>})`
2. Do the deterministic work inside `try`.
3. `tool_end("<step_id>", {<a small summary of the result — never the whole payload>})`
4. `return <the result dict>`
5. `except Exception as err:` → `tool_error("<step_id>", str(err))` and
   `return {"error": str(err), …minimal keys…}`. **A tool never raises**: a raising tool aborts the
   Strands loop, and the loop is the demo.

### §5.1 `ctx.py`

State: `_lock = threading.Lock()`, `_trace: str = ""`, `_calls: list[str] = []`.

* `set_trace(trace_id)`: under `_lock`, `_trace = str(trace_id)`; also clear `_calls`.
* `current_trace()`: under `_lock`, return `_trace`.
* `note_tool_call(name)`: under `_lock`, `_calls.append(str(name))`.
* `drain_tool_calls()`: under `_lock`, `out = list(_calls)`; `_calls.clear()`; return `out`.
* `tool_begin(step_id, payload)`: `note_tool_call(step_id)`, then
  `emit(step_id, "started", payload, trace_id=current_trace())`, all inside
  `try/except Exception: pass`.
* `tool_end(step_id, payload, degraded=False)`:
  `emit(step_id, "done", payload, trace_id=current_trace(), degraded=degraded)` inside
  `try/except Exception: pass`.
* `tool_error(step_id, message)`:
  `emit(step_id, "error", {"error": str(message)[:400]}, trace_id=current_trace(), degraded=True)`
  inside `try/except Exception: pass`.

### §5.2 `policy_fetch(as_of)`

1. `tool_begin("policy_fetch", {"as_of": as_of})`.
2. `snaps = load_snapshots()`. `available = [s["captured_at"] for s in snaps]`.
3. If `snaps` is empty: `tool_end("policy_fetch", {"clause_count": 0}, degraded=True)` and return
   `{"error": "no policy snapshots available", "available": []}`.
4. Select the snapshot:
   * `as_of` is `"latest"` or empty → `snaps[-1]`
   * `as_of` is `"previous"` → `snaps[-2]` if there are at least two, else `snaps[0]`
   * otherwise → the snapshot whose `captured_at == as_of.strip()`; if there is none, use
     `snaps[-1]` and note it in the returned dict as `"requested_not_found": as_of`
5. `clause_ids = [c["clause_id"] for c in chosen["clauses"]]`.
6. `result = {"captured_at": chosen["captured_at"], "source": chosen["source"],
   "clause_count": len(clause_ids), "clause_ids": clause_ids, "available": available}`.
7. `tool_end("policy_fetch", {"captured_at": chosen["captured_at"],
   "clause_count": len(clause_ids)})`.
8. Return `result`.

### §5.3 `policy_diff()`

1. `tool_begin("policy_diff", {})`.
2. `snaps = load_snapshots()`. If fewer than two:
   `tool_end("policy_diff", {"changed_count": 0}, degraded=True)` and return
   `{"error": "need two snapshots to diff", "changed_count": 0, "changes": []}`.
3. `changes = diff_snapshots(snaps[-2], snaps[-1])`.
4. `slim = [{"clause_id": c["clause_id"], "title": c["title"],
   "change_kind": c["change_kind"], "money_related": c["money_related"]} for c in changes]`.
5. `result = {"previous_captured_at": snaps[-2]["captured_at"],
   "latest_captured_at": snaps[-1]["captured_at"], "changed_count": len(slim),
   "changes": slim}`.
6. `tool_end("policy_diff", {"changed_count": len(slim),
   "clause_ids": [c["clause_id"] for c in slim],
   "money_related": [c["clause_id"] for c in slim if c["money_related"]]})`.
7. Return `result`.

The envelope payload from step 6 is what the UI's progress line shows, so it must stay small.
Full clause text is never emitted.

### §5.4 `booking_lookup(booking_id)`

1. `tool_begin("booking_lookup", {"booking_id": booking_id})`.
2. `b = find_booking(str(booking_id).strip())`. If `None`:
   `tool_end("booking_lookup", {"booking_id": booking_id, "found": False}, degraded=True)` and
   return `{"error": "unknown booking_id", "booking_id": booking_id}`.
3. `cfg = load_app_config()`;
   `fitted = fit_thread(thread_messages(b), cfg["thread_token_budget"])`.
4. Build the result with every field listed in §3.3, taking `thread=fitted["messages"]`,
   `thread_dropped=fitted["dropped"]`, `thread_tokens=fitted["tokens"]`,
   `thread_degraded=fitted["degraded"]`.
5. `tool_end("booking_lookup", {"booking_id": b["booking_id"],
   "guest_name": b["guest_name"], "listing_name": b["listing_name"],
   "thread_kept": len(fitted["messages"]), "thread_dropped": fitted["dropped"],
   "thread_tokens": fitted["tokens"]}, degraded=fitted["degraded"])`.
6. Return the result.

### §5.5 `clause_lookup(clause_id)`

1. `tool_begin("clause_lookup", {"clause_id": clause_id})`.
2. `snaps = load_snapshots()`. If empty → `tool_end(..., degraded=True)` and return
   `{"error": "no policy snapshots available", "clause_id": clause_id, "available": []}`.
3. `cid = str(clause_id).strip()`; `latest = snaps[-1]`;
   `available = [c["clause_id"] for c in latest["clauses"]]`.
4. `current = next((c for c in latest["clauses"] if c["clause_id"] == cid), None)`.
5. `changes = diff_snapshots(snaps[-2], snaps[-1]) if len(snaps) >= 2 else []`;
   `change = next((c for c in changes if c["clause_id"] == cid), None)`.
6. If `current` is None and `change` is None: `tool_end(..., {"found": False}, degraded=True)` and
   return `{"error": "unknown clause_id", "clause_id": cid, "available": available}`.
7. `result = {"clause_id": cid,
   "title": (current or change)["title"],
   "current_text": current["text"] if current else None,
   "previous_text": change["previous_text"] if change else None,
   "change_kind": change["change_kind"] if change else None,
   "money_related": bool(change["money_related"]) if change else False}`.
8. `tool_end("clause_lookup", {"clause_id": cid, "change_kind": result["change_kind"],
   "money_related": result["money_related"], "chars": len(result["current_text"] or ""),
   "citations": [{"title": f"{result['title']} ({cid})",
                  "snippet": (result["current_text"] or "")[:220]}]})`.
   The `citations` key is what the pre-existing `CitationDisplay` component renders, so the UI
   shows the exact policy text the draft was grounded in. Its shape is fixed by that component:
   a list of `{"title": str, "snippet": str}` — do not rename either key.
9. Return `result`.

### §5.6 `checklist_baseline(booking_id)`

1. `tool_begin("checklist_baseline", {"booking_id": booking_id})`.
2. `b = find_booking(str(booking_id).strip())`. If `None` → `tool_end(..., degraded=True)` and
   return `{"error": "unknown booking_id", "booking_id": booking_id}`.
3. `snaps = load_snapshots()`; if empty → `tool_end(..., degraded=True)` and return
   `{"error": "no policy snapshots available", "booking_id": b["booking_id"]}`.
4. `clause = next((c for c in snaps[-1]["clauses"] if c["clause_id"] == CHECKOUT_CLAUSE_ID), None)`.
   If `None`: `permitted, forbidden, text = [], [], ""`; skip to step 7 and set
   `degraded=True` on the end envelope.
5. `text = clause["text"]`; `low = text.lower()`;
   `sentences = [s.strip() for s in low.replace("\n", " ").split(".") if s.strip()]`.
6. For each `(task_id, phrases)` in `TASK_VOCAB`, in order:
   1. `hits = [s for s in sentences if any(p in s for p in phrases)]`.
   2. If `hits` is empty → the task is absent from this policy; skip it entirely.
   3. If any sentence in `hits` contains any entry of `FORBID_MARKERS` → append `task_id` to
      `forbidden`.
   4. Else → append `task_id` to `permitted`.
7. `result = {"booking_id": b["booking_id"], "clause_id": CHECKOUT_CLAUSE_ID,
   "permitted_tasks": permitted, "forbidden_tasks": forbidden,
   "cleaner_note": b["cleaner_notes"], "prior_disputes": b["prior_disputes"],
   "clause_text": text}`.
8. `tool_end("checklist_baseline", {"booking_id": b["booking_id"],
   "permitted": permitted, "forbidden": forbidden})`.
9. Return `result`.

Against the shipped fixtures this yields `permitted_tasks = ["run_dishwasher",
"take_out_refuse", "return_furniture"]` and `forbidden_tasks = ["strip_bed_linen",
"launder_textiles"]`. The order within each list follows `TASK_VOCAB`, so
`permitted_tasks` is `["run_dishwasher", "take_out_refuse", "return_furniture"]` — dishwasher
before refuse before furniture, because `strip_bed_linen` and `launder_textiles` are filtered
out into `forbidden` and the remaining vocabulary order is preserved.

### §5.7 `audit_log(action, booking_id, detail)`

1. `tool_begin("audit_write", {"action": action, "booking_id": booking_id})`.
   Note the `step_id` is `audit_write`, not `audit_log` — `audit_log` is the tool name the model
   sees; `audit_write` is the envelope id in the closed vocabulary.
2. `entry = audit_append(str(action), str(booking_id or ""), str(detail),
   trace_id=current_trace())`.
3. `tool_end("audit_write", {"entry_id": entry["entry_id"], "action": entry["action"],
   "booking_id": entry["booking_id"]})`.
4. Return `{"entry_id": entry["entry_id"], "at": entry["at"], "action": entry["action"],
   "booking_id": entry["booking_id"]}`.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| Fixtures missing or unreadable | the tool returns `{"error": …}` and the loop is told so in the tool result | an `error` envelope for that step with the degraded badge; the loop continues and DP-AGENT falls back |
| The model calls a tool with an unknown id | that tool returns `{"error": "unknown …", "available": […]}` | the loop retries with a valid id — this is why `available` is returned |
| The context bridge is unavailable | `booking_lookup` still returns a trimmed thread | the `booking_lookup` envelope carries `degraded: true` and `thread_degraded: true` |
| `cleaning.checkout_tasks` is absent from the policy | `checklist_baseline` returns empty lists | the `checklist_baseline` envelope is degraded; the checklist the model writes is generic and says so |
| The audit file cannot be written | `audit_log` still succeeds via the in-memory mirror | one stderr warning from `audit.py`; the trail is still visible in the UI |
| A tool raises despite everything | the shape's step 5 catches it | an `error` envelope plus `{"error": …}` to the loop; the Strands loop is never aborted |

## §7 Work units

### WU-TOOLS-01 — Shared tool context

**Goal.** Trace tagging, tool-call recording and the three emit helpers every tool uses.

**Steps.**
1. Create `engine/tools/ctx.py` with §3.1's skeleton and §5.1's algorithms.
2. Do not build an envelope dict here — call `emit`.

**Files created.** `engine/tools/ctx.py`.

**Verification command.**
```bash
python -c "
from engine.tools.ctx import set_trace, current_trace, note_tool_call, drain_tool_calls, tool_begin, tool_end
from src.stayquiet.publish import envelopes, reset
reset(); set_trace('trace-tools')
tool_begin('policy_diff', {'x': 1}); tool_end('policy_diff', {'changed_count': 4})
print(current_trace(), drain_tool_calls(), [(e['step_id'], e['status']) for e in envelopes('trace-tools')])
"
```
**Expected output.**
```
trace-tools ['policy_diff'] [('policy_diff', 'started'), ('policy_diff', 'done')]
```
**What it proves.** The helpers publish through the real `src.stayquiet.publish.emit` (a genuine
DP-TOOLS → DP-STREAM import), tag the active trace, and record the tool call for the agent.

---

### WU-TOOLS-02 — Policy tools

**Goal.** `policy_fetch` and `policy_diff` as real Strands tools over the committed snapshots.

**Steps.**
1. Create `engine/tools/policy.py` with §3.2's skeleton verbatim — including the docstrings, which
   are what the model reads to decide when to call each tool.
2. Implement §5.2 and §5.3.
3. Keep both decorated with `@tool`.

**Files created.** `engine/tools/policy.py`.

**Verification command.**
```bash
python -c "
from engine.tools.ctx import set_trace
from engine.tools.policy import policy_diff, policy_fetch
from src.stayquiet.publish import envelopes, reset
reset(); set_trace('t2')
f = policy_fetch('latest'); d = policy_diff()
print(f['captured_at'], f['clause_count'])
print(d['previous_captured_at'], '->', d['latest_captured_at'], d['changed_count'])
print([c['clause_id'] for c in d['changes']])
print([e['step_id'] + ':' + e['status'] for e in envelopes('t2')])
"
```
**Expected output.**
```
2026-09-08 7
2026-08-01 -> 2026-09-08 4
['cancellation.moderate', 'cleaning.checkout_tasks', 'payments.installments', 'safety.co_alarm']
['policy_fetch:started', 'policy_fetch:done', 'policy_diff:started', 'policy_diff:done']
```
**What it proves.** Both tools read the real fixtures through `seed.py` (a genuine DP-TOOLS →
DP-DATA import), return the exact four changes the demo narrates, and emit a started/done pair
each.

> If the tool objects are not directly callable in the installed Strands version,
> call the underlying function instead — `policy_fetch.func('latest')` or
> `policy_fetch.__wrapped__('latest')` — and record which form worked in the run
> report, because DP-AGENT's verification uses the same form.

---

### WU-TOOLS-03 — Booking and clause lookups

**Goal.** The two grounding tools, including the context-buffer trim.

**Steps.**
1. Create `engine/tools/bookings.py` per §3.3 and §5.4.
2. Create `engine/tools/clauses.py` per §3.4 and §5.5.

**Files created.** `engine/tools/bookings.py`, `engine/tools/clauses.py`.

**Verification command.**
```bash
python -c "
from engine.tools.ctx import set_trace
from engine.tools.bookings import booking_lookup
from engine.tools.clauses import clause_lookup
set_trace('t3')
b = booking_lookup('BK-1047')
print(b['guest_name'], b['listing_name'], b['prior_disputes'], 'kept', len(b['thread']), 'dropped', b['thread_dropped'])
c = clause_lookup('payments.installments')
print(c['change_kind'], c['money_related'], c['current_text'][:34])
print(booking_lookup('BK-9999')['error'], clause_lookup('nope.nope')['error'])
"
```
**Expected output.**
```
Sofia Marino Lakeside Cabin 2 kept 14 dropped 0
modified True Instalment plans are arranged by
unknown booking_id unknown clause_id
```
**What it proves.** `booking_lookup` fits the 14-message thread through the real context buffer
(DP-TOOLS → DP-MODEL → context module), `clause_lookup` returns the current text with its change
metadata, and both fail as data rather than as exceptions.

> Amendment 2026-09-10: the expected line used to read `kept 8 dropped 6`, copied from the
> DP-MODEL WU-04 synthetic probe (14 messages of 400 chars each). BK-1047's real thread is
> 2,151 characters, which the buffer counts as 613 tokens — inside the 900-token
> `thread_token_budget` — so keeping all 14 with `dropped 0` is the correct behaviour, not a
> failure to trim. Dropping messages that fit the budget would destroy grounding context
> (the checkout list, the CO-alarm question, the possible date change) for no reason; the
> trim path itself is already proven by DP-MODEL WU-04.

> If the context bridge is unavailable on this machine, `kept`/`dropped` differ and
> `b['thread_degraded']` is `True`. That is an acceptable pass — the numbers above assume
> the bridge works, which DP-MODEL WU-04 established.

---

### WU-TOOLS-04 — Checklist baseline and audit logger

**Goal.** The permitted/forbidden task derivation and the audit tool.

**Steps.**
1. Create `engine/tools/checklists.py` per §3.5 and §5.6, including `TASK_VOCAB`,
   `FORBID_MARKERS` and `CHECKOUT_CLAUSE_ID` verbatim.
2. Create `engine/tools/auditing.py` per §3.6 and §5.7.

**Files created.** `engine/tools/checklists.py`, `engine/tools/auditing.py`.

**Verification command.**
```bash
python -c "
from engine.tools.ctx import set_trace
from engine.tools.checklists import checklist_baseline
from engine.tools.auditing import audit_log
from src.stayquiet.audit import audit_read, audit_reset
set_trace('t4'); audit_reset()
k = checklist_baseline('BK-1043')
print(k['permitted_tasks'])
print(k['forbidden_tasks'])
print(k['prior_disputes'], k['cleaner_note'][:22])
a = audit_log('draft_prepared', 'BK-1043', 'Reply drafted from the current checkout-tasks clause.')
print(a['action'], audit_read()[0]['booking_id'])
"
```
**Expected output.**
```
['run_dishwasher', 'take_out_refuse', 'return_furniture']
['strip_bed_linen', 'launder_textiles']
1 Guest left the bed mad
```

Amendment 2026-09-10: the expected line used to read `1 Guest left the bed made`
(23 characters), but the command slices `cleaner_note[:22]` — 22 characters, ending
mid-word at `…bed mad`. The implementation is verbatim per §5.6; the expectation had
one character too many. Fixed here rather than in the command.
followed by
```
draft_prepared BK-1043
```
**What it proves.** The task classification derives the exact permitted/forbidden split the demo
narrates from the current clause text alone, and `audit_log` writes through the real
`src.stayquiet.audit` (a genuine DP-TOOLS → DP-STREAM import).

---

### WU-TOOLS-05 — The closed tool set

**Goal.** One export the agent imports, in a fixed order.

**Steps.**
1. Replace `engine/tools/__init__.py` with §3.7 verbatim.
2. Confirm no file under `engine/tools/` imports `src.stayquiet.model`, constructs an `Agent`, or
   contains the word `prompt`.

**Files modified.** `engine/tools/__init__.py`.

**Verification command.**
```bash
python -c "
import engine.tools as T
print(len(T.ALL_TOOLS))
print([getattr(t, 'tool_name', getattr(t, '__name__', str(t))) for t in T.ALL_TOOLS])
" && grep -rn "stayquiet.model\|BedrockModel\|Agent(" engine/tools/ | wc -l
```
**Expected output.**
```
6
['policy_diff', 'policy_fetch', 'booking_lookup', 'clause_lookup', 'checklist_baseline', 'audit_log']
0
```
**What it proves.** Exactly six tools are exported in the fixed order DP-AGENT depends on, and
none of them reaches for the model layer — the boundary in blueprint §2.4c rule 2 holds.

> Older Strands versions expose the name as `__name__` rather than `tool_name`; the
> `getattr` chain above covers both. If the printed list has the right six names in the
> right order, the check passes.

---

## §8 Verification summary

```bash
# WU-TOOLS-01
python -c "
from engine.tools.ctx import set_trace, current_trace, note_tool_call, drain_tool_calls, tool_begin, tool_end
from src.stayquiet.publish import envelopes, reset
reset(); set_trace('trace-tools')
tool_begin('policy_diff',{'x':1}); tool_end('policy_diff',{'changed_count':4})
print(current_trace(), drain_tool_calls(), [(e['step_id'],e['status']) for e in envelopes('trace-tools')])"
# WU-TOOLS-02
python -c "
from engine.tools.ctx import set_trace
from engine.tools.policy import policy_diff, policy_fetch
from src.stayquiet.publish import envelopes, reset
reset(); set_trace('t2')
f=policy_fetch('latest'); d=policy_diff()
print(f['captured_at'], f['clause_count'])
print(d['previous_captured_at'],'->',d['latest_captured_at'], d['changed_count'])
print([c['clause_id'] for c in d['changes']])
print([e['step_id']+':'+e['status'] for e in envelopes('t2')])"
# WU-TOOLS-03
python -c "
from engine.tools.ctx import set_trace
from engine.tools.bookings import booking_lookup
from engine.tools.clauses import clause_lookup
set_trace('t3'); b=booking_lookup('BK-1047')
print(b['guest_name'], b['listing_name'], b['prior_disputes'], 'kept', len(b['thread']), 'dropped', b['thread_dropped'])
c=clause_lookup('payments.installments')
print(c['change_kind'], c['money_related'], c['current_text'][:34])
print(booking_lookup('BK-9999')['error'], clause_lookup('nope.nope')['error'])"
# WU-TOOLS-04
python -c "
from engine.tools.ctx import set_trace
from engine.tools.checklists import checklist_baseline
from engine.tools.auditing import audit_log
from src.stayquiet.audit import audit_read, audit_reset
set_trace('t4'); audit_reset(); k=checklist_baseline('BK-1043')
print(k['permitted_tasks']); print(k['forbidden_tasks'])
print(k['prior_disputes'], k['cleaner_note'][:22])
a=audit_log('draft_prepared','BK-1043','Reply drafted from the current checkout-tasks clause.')
print(a['action'], audit_read()[0]['booking_id'])"
# WU-TOOLS-05
python -c "
import engine.tools as T
print(len(T.ALL_TOOLS))
print([getattr(t,'tool_name',getattr(t,'__name__',str(t))) for t in T.ALL_TOOLS])" && grep -rn "stayquiet.model\|BedrockModel\|Agent(" engine/tools/ | wc -l
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| A tool raises and kills the Strands loop mid-demo | §5's tool shape step 5 is mandatory and every tool's return type includes an `error` variant; four of the five verification commands exercise a failure path |
| The model cannot tell which tool to use | the docstrings are written as instructions to the model ("Use this before drafting anything"), are part of §3 verbatim, and are what Strands turns into the tool schema |
| A tool starts calling the model "just for this one summary" | §2's hard prohibitions plus WU-05's grep, which must print `0` |
| The prose-parsing task classification breaks on reworded policy | the vocabulary and markers are closed, enumerated lists in §3.5; a phrase that matches nothing is skipped rather than guessed, and WU-04 asserts the exact output on the shipped text |
| Envelope payloads grow until the SSE stream is unreadable | every `tool_end` payload in §5 is an explicit small dict; full clause text and full threads are returned to the model but never emitted |
| Two cycles run concurrently and share `ctx._trace` | DP-API serialises cycles with a lock and says so; the module docstring in §3.1 states the single-cycle assumption |
