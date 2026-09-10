# DP-API — FastAPI service: SSE, REST, SPA hosting, background scheduler

## §0 Context & blockers

Must already exist:

* **DP-FOUND**: `src/stayquiet/config.py`; `fastapi` and `uvicorn` installed.
* **DP-STREAM**: `src/stayquiet/publish.py` (`emit`, `new_trace_id`, `since`, `snapshot`,
  `latest_sequence`), `src/stayquiet/store.py` (`latest_run`, `list_decisions`, `get_decision`,
  `resolve_decision`), `src/stayquiet/audit.py` (`audit_append`, `audit_read`).
* **DP-MODEL**: `src/stayquiet/model.py` (`cost_snapshot`).
* **DP-AGENT**: `engine/agents/__init__.py` exporting `run_cycle`; DP-AGENT WU-04 passing.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Own the one process a judge talks to: it runs cycles in the background with nobody watching,
streams what the agent is doing, serves the built single-page app, and takes the host's approve or
edit.

Requirements (blueprint §1): **SQ-F-07** (approve/edit endpoint, resolution written to the audit
trail), **SQ-F-09** (a background scheduler starts the work; there is no prompt box and no "run"
button is required for work to happen), **SQ-F-10** (every step streams as an `EventEnvelope` over
SSE with a non-streaming fallback), **SQ-F-13** (public, login-free, testable with nobody present).

## §2 Scope boundaries

### IN — the only files this plan creates

1. `src/stayquiet/api.py`
2. `src/stayquiet/__main__.py`

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `engine/**` | DP-TOOLS / DP-AGENT |
| `src/stayquiet/publish.py`, `store.py`, `audit.py` | DP-STREAM |
| `src/stayquiet/model.py`, `context_bridge.py` | DP-MODEL |
| `src/stayquiet/seed.py` | DP-DATA |
| `src/stayquiet/web/**`, `index.html`, `vite.config.ts` | DP-UI |
| `Dockerfile`, `scripts/**` | DP-DEPLOY |
| `src/platform/**` | pre-existing — read-only |

Hard prohibitions:

* **No business logic here.** The API starts cycles, reads state, and resolves decisions. It never
  drafts, never diffs, never triages, never decides an exposure figure.
* **No `Agent`, no `BedrockModel`, no `with_resilience`, no `emit`-by-hand.**
* **No authentication, no rate limit, no cookie.** The rules require the project to be usable
  "free of charge and without any restriction, for testing, evaluation and use". A login would
  break that.
* **`src/platform/transport/stream_router.py` is not imported.** Its `publish()` is `async` and its
  own header calls it illustrative; this plan writes the eight-line SSE generator itself over
  `since()`.

## §3 Interfaces owned

### 3.1 `src/stayquiet/api.py`

```python
# StayQuiet — the HTTP surface (blueprint §2.4 row 32).
#
# Routes, in matching order:
#   GET  /healthz                     liveness, for the deploy smoke check
#   GET  /events/stream               SSE: one `event: envelope` frame per EventEnvelope
#   GET  /events                      non-streaming fallback snapshot (TRN-RES-03)
#   GET  /api/state                   everything the UI renders in one object
#   GET  /api/decisions               the decision queue
#   POST /api/decisions/{decision_id} the host's approve or edit
#   GET  /api/audit                   the audit trail
#   POST /api/runs                    start one cycle now (the UI's "run now")
#   GET  /assets/*                    the built SPA's static assets
#   GET  /{path:path}                 the SPA's index.html (single-page fallback)
#
# The background scheduler runs a cycle at startup and then every
# AppConfig["cycle_interval_s"] seconds, with no request and no prompt — that is the
# product's core claim, so it lives here and not behind a button.
from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from engine.agents import run_cycle
from src.stayquiet.audit import audit_append, audit_read
from src.stayquiet.config import load_app_config, repo_root
from src.stayquiet.model import cost_snapshot
from src.stayquiet.publish import emit, latest_sequence, new_trace_id, since, snapshot
from src.stayquiet.store import get_decision, latest_run, list_decisions, resolve_decision

#: Seconds between SSE polls of the envelope ring. 0.25 s is invisible to a viewer
#: and costs nothing; there is no queue to manage and no async hand-off from the
#: synchronous agent loop.
SSE_POLL_S: float = 0.25

#: Comment frames are sent after this many idle polls so proxies keep the
#: connection open (0.25 s * 60 = 15 s).
SSE_KEEPALIVE_POLLS: int = 60

#: Directory the built SPA is served from (`npm run build:ui` output).
DIST_DIR: Path = repo_root() / "dist"

#: Only one cycle may run at a time: the tools share a module-level trace id.
_cycle_lock = threading.Lock()


def cycle_running() -> bool:
    """True while a cycle holds the lock."""


def start_cycle_sync(trace_id: str | None = None) -> dict:
    """Run one cycle to completion in the calling thread, guarded by the lock.

    Returns the CycleResult, or {"skipped": True, "reason": "cycle_already_running"}
    when the lock is held. Never raises — run_cycle() has its own outer guard.
    """


async def start_cycle_bg(trace_id: str | None = None) -> dict:
    """Start a cycle in a worker thread and return immediately.

    Returns {"run_id": str|None, "trace_id": str, "started": bool}. The cycle keeps
    running after the response is sent, which is what makes the stream worth
    watching.
    """


def build_state() -> dict:
    """Everything the UI renders, in one object (§5.3)."""


def create_app() -> FastAPI:
    """Build the FastAPI application with every route and the scheduler task."""


app = create_app()
```

### 3.2 `src/stayquiet/__main__.py`

```python
# StayQuiet — `python -m src.stayquiet` starts the whole product on one port.
# PORT (default 8080) and HOST (default 0.0.0.0) come from the environment so the
# container needs no arguments.
from __future__ import annotations

import os

import uvicorn


def main() -> None:
    """Serve src.stayquiet.api:app with uvicorn. Blocks until interrupted."""
    uvicorn.run(
        "src.stayquiet.api:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
        access_log=False,
    )


if __name__ == "__main__":
    main()
```

## §4 Interfaces consumed

Copy verbatim.

```python
from engine.agents import run_cycle                                       # DP-AGENT
from src.stayquiet.audit import audit_append, audit_read                  # DP-STREAM
from src.stayquiet.config import load_app_config, repo_root               # DP-FOUND
from src.stayquiet.model import cost_snapshot                             # DP-MODEL
from src.stayquiet.publish import (                                       # DP-STREAM
    emit,
    latest_sequence,
    new_trace_id,
    since,
    snapshot,
)
from src.stayquiet.store import (                                         # DP-STREAM
    get_decision,
    latest_run,
    list_decisions,
    resolve_decision,
)
```

## §5 Algorithms

### §5.1 Cycle guarding and background start

* `cycle_running()`: `return _cycle_lock.locked()`.
* `start_cycle_sync(trace_id)`:
  1. `acquired = _cycle_lock.acquire(blocking=False)`.
  2. If not `acquired`: return `{"skipped": True, "reason": "cycle_already_running"}`.
  3. `try: return run_cycle({"trace_id": trace_id} if trace_id else {})`
     `finally: _cycle_lock.release()`.
* `start_cycle_bg(trace_id)`:
  1. `tid = trace_id or new_trace_id()`.
  2. If `cycle_running()`: return `{"run_id": None, "trace_id": tid, "started": False}`.
  3. `asyncio.create_task(asyncio.to_thread(start_cycle_sync, tid))` — do **not** await it.
  4. Return `{"run_id": None, "trace_id": tid, "started": True}` (the run id appears in the
     `cycle`/`started` envelope moments later, and in `/api/state`).

### §5.2 The SSE route

```python
async def _envelope_stream(request: Request, trace_id: Optional[str]):
    last = 0
    idle = 0
    yield ": connected\n\n"
    while True:
        if await request.is_disconnected():
            return
        batch = since(last, trace_id)
        if batch:
            for env in batch:
                last = env["sequence"]
                yield f"id: {env['sequence']}\nevent: envelope\ndata: {json.dumps(env)}\n\n"
            idle = 0
        else:
            idle += 1
            if idle >= SSE_KEEPALIVE_POLLS:
                idle = 0
                yield ": keepalive\n\n"
        await asyncio.sleep(SSE_POLL_S)
```

Route:

```python
@app.get("/events/stream")
async def events_stream(request: Request, trace_id: str | None = None) -> StreamingResponse:
    return StreamingResponse(
        _envelope_stream(request, trace_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )
```

The frame format — `id:`, `event: envelope`, `data: <json>`, blank line — is fixed by the
pre-existing subscriber, which listens for the event name `envelope` and connects to
`/events/stream` with an optional `?trace_id=` query. Do not rename either.
`X-Accel-Buffering: no` stops a reverse proxy from buffering the stream into silence.

`GET /events` returns `JSONResponse(snapshot(trace_id))` — the exact
`{status, trace_id, events, degraded}` body the fallback path expects.

### §5.3 `build_state()`

```python
{
  "synthetic": True,                       # every record on screen is synthetic
  "run": latest_run(),                     # RunRecord | None
  "cycle_running": cycle_running(),
  "decisions": <pending first, then resolved, newest first within each group>,
  "audit": audit_read(60),
  "cost": cost_snapshot(),
  "events": snapshot()["events"],          # so the UI fills in even with no SSE
  "latest_sequence": latest_sequence(),
  "config": {
      "demo_mode": cfg["demo_mode"],
      "model_id": cfg["model_id"],
      "region": cfg["region"],
      "cycle_interval_s": cfg["cycle_interval_s"],
      "track": "Professional Agents",
      "stack": "Strands Agents SDK for Python on Amazon Bedrock",
  },
}
```

Decision ordering: `list_decisions("pending") + [d for d in list_decisions() if d["status"] !=
"pending"]`. Wrap the whole function in `try/except Exception`, returning the same keys with empty
values and an extra `"error": str(err)` — a broken state read must render an empty dashboard, not a
500.

### §5.4 `POST /api/decisions/{decision_id}`

Request body (JSON): `{"action": "approve" | "edit", "text": "<required only for edit>"}`.

1. Parse the body with `await request.json()`, guarded: a malformed body → HTTP 400
   `{"error": "invalid JSON body"}`.
2. `action = str(body.get("action", "")).strip().lower()`;
   `text = body.get("text")`.
3. `d = resolve_decision(decision_id, action, text if isinstance(text, str) else None)`.
4. If `d` is `None`:
   * if `get_decision(decision_id)` is `None` → HTTP 404 `{"error": "unknown decision_id"}`
   * else → HTTP 400 `{"error": "action must be approve, or edit with non-empty text"}`
5. On success:
   1. `audit_append("host_decision", d["booking_id"],
      f"Host {d['status']} the {d['kind'].replace('_',' ')} reply for {d['guest_name']}. "
      f"Modelled exposure {d['modelled_exposure_eur']:.2f} EUR.",
      trace_id=d["trace_id"], degraded=d["degraded"])`
   2. `emit("decision_resolved", "done",
      {"decision_id": d["decision_id"], "booking_id": d["booking_id"],
       "kind": d["kind"], "status": d["status"],
       "modelled_exposure_eur": d["modelled_exposure_eur"]},
      trace_id=d["trace_id"])`
   3. Return `JSONResponse({"decision": d})`.

This is the only place a host action is recorded. `store.py` changes the record; the audit line and
the envelope are the API's job (blueprint §2.4c rule 4 and DP-STREAM §5.3 both say so).

### §5.5 The remaining routes

* `GET /healthz` → `{"ok": True, "cycle_running": cycle_running(), "sequence": latest_sequence()}`.
* `GET /api/state` → `JSONResponse(build_state())`.
* `GET /api/decisions` → `JSONResponse({"decisions": build_state()["decisions"]})`.
* `GET /api/audit?limit=200` → `JSONResponse({"audit": audit_read(min(max(int(limit), 1), 500))})`,
  a bad `limit` falling back to 200.
* `POST /api/runs` → `JSONResponse(await start_cycle_bg())`.
* Static assets: after every route above is registered,
  ```python
  assets = DIST_DIR / "assets"
  if assets.is_dir():
      app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")
  ```
* SPA fallback, registered LAST so it cannot shadow anything:
  ```python
  @app.get("/{path:path}")
  async def spa(path: str):
      index = DIST_DIR / "index.html"
      if index.is_file():
          return HTMLResponse(index.read_text(encoding="utf-8"))
      return HTMLResponse(PLACEHOLDER_HTML, status_code=200)
  ```
  `PLACEHOLDER_HTML` is this exact string, so a container without a built frontend is still a
  usable, honest page rather than a 404:
  ```html
  <!doctype html><meta charset="utf-8"><title>StayQuiet</title>
  <body style="font:16px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
  <h1>StayQuiet</h1>
  <p>The API is running. The interface has not been built in this image.</p>
  <p>Build it with <code>npm install &amp;&amp; npm run build:ui</code>, or use the API directly:
  <a href="/api/state">/api/state</a>, <a href="/events">/events</a>,
  <a href="/healthz">/healthz</a>.</p>
  </body>
  ```

### §5.6 The background scheduler

Registered on the FastAPI startup event inside `create_app()`:

```python
async def _scheduler() -> None:
    cfg = load_app_config()
    await asyncio.sleep(2.0)                 # let the server bind first
    while True:
        if not cycle_running():
            await asyncio.to_thread(start_cycle_sync, None)
        await asyncio.sleep(max(5, int(cfg["cycle_interval_s"])))
```

1. `@app.on_event("startup")` creates the task with
   `app.state.scheduler_task = asyncio.create_task(_scheduler())`.
2. `@app.on_event("shutdown")` cancels it, suppressing `asyncio.CancelledError`.
3. Wrap the body of the `while` loop in `try/except Exception`, printing
   `[stayquiet] scheduler tick failed ({err}); continuing` — a failed tick must never end the
   scheduler.
4. The first tick runs two seconds after startup, so a judge who opens the page sees a cycle in
   progress without pressing anything. That is the product's central claim; do not move it behind
   the button.

Set `STAYQUIET_CYCLE_INTERVAL_S=30` when recording the demo so a second cycle happens on camera.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| A cycle is already running when another is requested | the second request is ignored | `{"started": false}` and an unchanged UI; the running cycle keeps streaming |
| `run_cycle` degrades entirely | nothing structural | the stream shows degraded badges; `/api/state` still returns a full run record |
| SSE blocked by a proxy | the live stream | `useEventStream` falls back, and `/api/state` carries `events` anyway, so the UI fills in on its next poll |
| A client disconnects mid-stream | that connection only | the generator returns on `is_disconnected()`; other clients are untouched |
| The SPA is not built into the image | the interface | `PLACEHOLDER_HTML` explains how to build it and links the three API endpoints |
| `build_state()` raises | one poll | an object with empty values plus `"error"`; the UI shows its empty states rather than a 500 |
| The scheduler tick raises | that tick | one stderr line; the next tick runs on schedule |

## §7 Work units

### WU-API-01 — Routes and state

**Goal.** The service, with every route and no scheduler yet.

**Steps.**
1. Create `src/stayquiet/api.py` with §3.1's skeleton verbatim.
2. Implement `cycle_running`, `start_cycle_sync`, `start_cycle_bg` (§5.1), `build_state` (§5.3),
   the SSE route and `/events` (§5.2), `POST /api/decisions/{decision_id}` (§5.4) and the
   remaining routes (§5.5), including `PLACEHOLDER_HTML`.
3. Register the SPA catch-all **last**.
4. Create `src/stayquiet/__main__.py` with §3.2 verbatim.

**Files created.** `src/stayquiet/api.py`, `src/stayquiet/__main__.py`.

**Verification command.**
```bash
STAYQUIET_DEMO_MODE=1 python -c "
from fastapi.testclient import TestClient
from src.stayquiet.api import app
c = TestClient(app)
print('health', c.get('/healthz').json()['ok'])
s = c.get('/api/state').json()
print('state-keys', sorted(s.keys()))
print('track', s['config']['track'], 'synthetic', s['synthetic'])
print('events-shape', sorted(c.get('/events').json().keys()))
print('spa', '<h1>StayQuiet</h1>' in c.get('/').text or 'stayquiet' in c.get('/').text.lower())
print('404', c.post('/api/decisions/DEC-nope', json={'action':'approve'}).status_code)
"
```
**Expected output.**
```
health True
state-keys ['audit', 'config', 'cost', 'cycle_running', 'decisions', 'events', 'latest_sequence', 'run', 'synthetic']
track Professional Agents synthetic True
events-shape ['degraded', 'events', 'status', 'trace_id']
spa True
404 404
```
**What it proves.** Every route answers, `/api/state` has exactly the keys DP-UI reads,
`/events` returns the fallback shape the pre-existing subscriber expects, and an unknown decision
id is a 404 rather than a stack trace.

> `TestClient` needs `httpx`, which FastAPI's test client pulls in. If it is missing, install it
> with `pip install httpx` and note it in the run report — it is a test-only dependency and must
> NOT be added to `requirements.txt`.

---

### WU-API-02 — A real cycle over HTTP, streamed

**Goal.** Prove the whole product works through the HTTP surface, offline.

**Steps.**
1. Run the verification command. It starts a cycle through `POST /api/runs`, waits for it, then
   reads the state and the stream snapshot.
2. Do not change any expected count — they come from DP-AGENT's deterministic design.

**Files created/modified.** none.

**Verification command.**
```bash
STAYQUIET_DEMO_MODE=1 python -c "
import time
from fastapi.testclient import TestClient
from src.stayquiet.api import app
with TestClient(app) as c:
    r = c.post('/api/runs').json()
    print('started', r['started'])
    for _ in range(60):
        st = c.get('/api/state').json()
        if st['run'] and st['run']['status'] in ('done', 'error') and not st['cycle_running']:
            break
        time.sleep(0.5)
    run = st['run']
    print(run['status'], run['bookings_scanned'], run['bookings_affected'], len(run['decisions']), run['quiet_actions'])
    print('pending', sum(1 for d in st['decisions'] if d['status'] == 'pending'))
    print('kinds', [d['kind'] for d in st['decisions']])
    print('audit', len(st['audit']) > 0, 'events', len(st['events']) > 0)
    d0 = st['decisions'][0]['decision_id']
    print('approve', c.post(f'/api/decisions/{d0}', json={'action':'approve'}).json()['decision']['status'])
    print('resolved-envelope', any(e['step_id'] == 'decision_resolved' for e in c.get('/events').json()['events']))
    print('audit-has-host', any(a['action'] == 'host_decision' for a in c.get('/api/audit').json()['audit']))
"
```
**Expected output.**
```
started True
done 6 4 3 1
pending 3
kinds ['exception', 'refund', 'review_risk']
audit True events True
approve approved
resolved-envelope True
audit-has-host True
```
**What it proves.** A cycle really runs in the background from an HTTP call (a genuine DP-API →
DP-AGENT import), the deterministic counts survive the round trip, the host's approval is recorded
in the store, emitted as an envelope and written to the audit trail — the full SQ-F-07 path.

> The `kinds` order follows fixture order because pending decisions are listed first, newest
> first within the group, and all three were created in the same cycle. If your list is the same
> three values in a different order, that is a pass; the three values themselves are not.

---

### WU-API-03 — The scheduler, and the non-streaming fallback

**Goal.** Prove work happens with nobody asking, and that the product survives with no SSE.

**Steps.**
1. Add the scheduler per §5.6, wired to the startup and shutdown events.
2. Run the verification command with a 5-second interval so two ticks fit inside the test.

**Files modified.** `src/stayquiet/api.py`.

**Verification command.**
```bash
STAYQUIET_DEMO_MODE=1 STAYQUIET_CYCLE_INTERVAL_S=5 python -c "
import time
from fastapi.testclient import TestClient
from src.stayquiet.api import app
with TestClient(app) as c:
    for _ in range(20):                  # nobody has asked for anything; only reads
        st = c.get('/api/state').json()
        if st['run'] and st['run']['status'] in ('done', 'error') and not st['cycle_running']:
            break
        time.sleep(0.5)
    st = c.get('/api/state').json()
    print('unprompted-run', st['run'] is not None, st['run']['bookings_affected'] if st['run'] else None)
    snap = c.get('/events').json()
    print('snapshot', snap['status'], len(snap['events']) > 0, snap['degraded'])
    print('interval', st['config']['cycle_interval_s'])
"
```
**Expected output.**
```
unprompted-run True 4
snapshot complete True True
interval 5
```

Amendment 2026-09-10: the command used to read state after a fixed `sleep(4)`. The
scheduler's first tick fires at t=2s but a demo cycle takes ~2.3s (eight
resilience-wrapped turns, each with its mandated retry/backoff), so at t=4s the
unprompted run is still `running`: `bookings_affected` reads 0 and no degraded
envelope exists yet (measured: `True 0` / `complete True False`). The properties
under test — a run started with nobody asking, and it completes with the
deterministic counts — do not depend on a wall-clock guess, so the command now
polls boundedly for completion (the same 0.5 s pattern WU-API-02 uses) instead of
assuming a fixed duration. Asserted values are unchanged.
**What it proves.** A cycle ran two seconds after startup with no request, no prompt and no button
— the product's core claim (SQ-F-09) — and the complete run is retrievable from the non-streaming
`/events` snapshot alone, which is the bottom rung of the transport ladder (SQ-F-10).

---

## §8 Verification summary

```bash
# WU-API-01
STAYQUIET_DEMO_MODE=1 python -c "
from fastapi.testclient import TestClient
from src.stayquiet.api import app
c=TestClient(app)
print('health', c.get('/healthz').json()['ok'])
s=c.get('/api/state').json(); print('state-keys', sorted(s.keys()))
print('track', s['config']['track'], 'synthetic', s['synthetic'])
print('events-shape', sorted(c.get('/events').json().keys()))
print('spa', 'stayquiet' in c.get('/').text.lower())
print('404', c.post('/api/decisions/DEC-nope', json={'action':'approve'}).status_code)"
# WU-API-02
STAYQUIET_DEMO_MODE=1 python -c "
import time
from fastapi.testclient import TestClient
from src.stayquiet.api import app
with TestClient(app) as c:
    r=c.post('/api/runs').json(); print('started', r['started'])
    for _ in range(60):
        st=c.get('/api/state').json()
        if st['run'] and st['run']['status'] in ('done','error') and not st['cycle_running']: break
        time.sleep(0.5)
    run=st['run']; print(run['status'], run['bookings_scanned'], run['bookings_affected'], len(run['decisions']), run['quiet_actions'])
    print('pending', sum(1 for d in st['decisions'] if d['status']=='pending'))
    print('kinds', [d['kind'] for d in st['decisions']])
    print('audit', len(st['audit'])>0, 'events', len(st['events'])>0)
    d0=st['decisions'][0]['decision_id']
    print('approve', c.post(f'/api/decisions/{d0}', json={'action':'approve'}).json()['decision']['status'])
    print('resolved-envelope', any(e['step_id']=='decision_resolved' for e in c.get('/events').json()['events']))
    print('audit-has-host', any(a['action']=='host_decision' for a in c.get('/api/audit').json()['audit']))"
# WU-API-03
STAYQUIET_DEMO_MODE=1 STAYQUIET_CYCLE_INTERVAL_S=5 python -c "
import time
from fastapi.testclient import TestClient
from src.stayquiet.api import app
with TestClient(app) as c:
    for _ in range(20):
        st=c.get('/api/state').json()
        if st['run'] and st['run']['status'] in ('done','error') and not st['cycle_running']: break
        time.sleep(0.5)
    st=c.get('/api/state').json()
    print('unprompted-run', st['run'] is not None, st['run']['bookings_affected'] if st['run'] else None)
    snap=c.get('/events').json(); print('snapshot', snap['status'], len(snap['events'])>0, snap['degraded'])
    print('interval', st['config']['cycle_interval_s'])"
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| The SPA catch-all shadows `/api/*` or `/events` | §5.5 requires it to be registered last and WU-01 asserts a 404 from a real API route rather than an HTML page |
| Two overlapping cycles corrupt the shared trace id | `_cycle_lock` plus `cycle_running()`; the scheduler skips a tick while one runs, and `POST /api/runs` returns `started: false` |
| A long SSE connection blocks the event loop | the generator only sleeps and reads a list; the cycle itself runs in a worker thread via `asyncio.to_thread` |
| A reverse proxy buffers the stream and the demo looks frozen | `X-Accel-Buffering: no`, plus the keepalive comment frame every 15 s, plus the `/api/state` poll DP-UI does anyway |
| Someone adds authentication "for safety" | §2 forbids it and quotes the rule that requires unrestricted judge access; the data is entirely synthetic, so there is nothing to protect |
| Business logic creeps into a route handler | §2's first prohibition; every handler in §5.5 is one or two lines over a function owned by another plan |
| `on_event("startup")` deprecation in a future FastAPI | `requirements.txt` pins `fastapi>=0.115`, where both `on_event` and lifespan work; if a warning appears, it is a warning and the plan still passes |
