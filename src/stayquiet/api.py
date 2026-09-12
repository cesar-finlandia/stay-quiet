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
import sys
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
from src.stayquiet.publish import emit, envelopes, latest_sequence, new_trace_id, since, snapshot
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

#: Version marker for the duplicate-suppression fix (2026-09-12). Returned by
#: /api/state and /healthz so a deployment can be verified to carry the fix
#: with one request, without guessing from bundle hashes.
CODE_VERSION: str = "dedupe-1"

#: Only one cycle may run at a time: the tools share a module-level trace id.
_cycle_lock = threading.Lock()

PLACEHOLDER_HTML: str = """<!doctype html><meta charset="utf-8"><title>StayQuiet</title>
<body style="font:16px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>StayQuiet</h1>
<p>The API is running. The interface has not been built in this image.</p>
<p>Build it with <code>npm install &amp;&amp; npm run build:ui</code>, or use the API directly:
<a href="/api/state">/api/state</a>, <a href="/events">/events</a>,
<a href="/healthz">/healthz</a>.</p>
</body>
"""


def cycle_running() -> bool:
    """True while a cycle holds the lock."""
    return _cycle_lock.locked()


def start_cycle_sync(trace_id: str | None = None) -> dict:
    """Run one cycle to completion in the calling thread, guarded by the lock.

    Returns the CycleResult, or {"skipped": True, "reason": "cycle_already_running"}
    when the lock is held. Never raises — run_cycle() has its own outer guard.
    """
    acquired = _cycle_lock.acquire(blocking=False)
    if not acquired:
        return {"skipped": True, "reason": "cycle_already_running"}
    try:
        return run_cycle({"trace_id": trace_id} if trace_id else {})
    finally:
        _cycle_lock.release()


async def start_cycle_bg(trace_id: str | None = None) -> dict:
    """Start a cycle in a worker thread and return immediately.

    Returns {"run_id": str|None, "trace_id": str, "started": bool}. The cycle keeps
    running after the response is sent, which is what makes the stream worth
    watching.
    """
    tid = trace_id or new_trace_id()
    if cycle_running():
        return {"run_id": None, "trace_id": tid, "started": False}
    asyncio.create_task(asyncio.to_thread(start_cycle_sync, tid))
    return {"run_id": None, "trace_id": tid, "started": True}


def build_state() -> dict:
    """Everything the UI renders, in one object (§5.3)."""
    try:
        cfg = load_app_config()
        pending = list_decisions("pending")
        resolved = [d for d in list_decisions() if d["status"] != "pending"]
        # Scope events to the latest cycle's trace: the ring keeps every cycle
        # (~30 envelopes each), and returning all of them made /api/state grow
        # to hundreds of duplicated entries after a day of scheduler ticks.
        # The UI dedupes identical content on top of this.
        all_envs = envelopes()
        if all_envs:
            latest_tid = all_envs[-1].get("trace_id")
            latest_envs = [e for e in all_envs if e.get("trace_id") == latest_tid]
        else:
            latest_envs = []
        return {
            "synthetic": True,
            "run": latest_run(),
            "cycle_running": cycle_running(),
            "decisions": pending + resolved,
            "audit": audit_read(60),
            "cost": cost_snapshot(),
            "events": latest_envs,
            "latest_sequence": latest_sequence(),
            "code_version": CODE_VERSION,
            "config": {
                "demo_mode": cfg["demo_mode"],
                "model_id": cfg["model_id"],
                "region": cfg["region"],
                "cycle_interval_s": cfg["cycle_interval_s"],
                "track": "Professional Agents",
                "stack": "Strands Agents SDK for Python on Amazon Bedrock",
            },
        }
    except Exception as err:
        try:
            cfg = load_app_config()
            config = {
                "demo_mode": cfg["demo_mode"],
                "model_id": cfg["model_id"],
                "region": cfg["region"],
                "cycle_interval_s": cfg["cycle_interval_s"],
                "track": "Professional Agents",
                "stack": "Strands Agents SDK for Python on Amazon Bedrock",
            }
        except Exception:
            config = {}
        return {
            "synthetic": True,
            "run": None,
            "cycle_running": False,
            "decisions": [],
            "audit": [],
            "cost": {},
            "events": [],
            "latest_sequence": 0,
            "config": config,
            "error": str(err),
        }


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


async def _scheduler() -> None:
    cfg = load_app_config()
    await asyncio.sleep(2.0)
    while True:
        try:
            if not cycle_running():
                await asyncio.to_thread(start_cycle_sync, None)
        except Exception as err:
            try:
                print(f"[stayquiet] scheduler tick failed ({err}); continuing",
                      file=sys.stderr)
            except Exception:
                pass
        await asyncio.sleep(max(5, int(cfg["cycle_interval_s"])))


def create_app() -> FastAPI:
    """Build the FastAPI application with every route and the scheduler task."""
    app = FastAPI(title="StayQuiet")

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "cycle_running": cycle_running(),
                "sequence": latest_sequence(), "code_version": CODE_VERSION}

    @app.get("/events/stream")
    async def events_stream(request: Request, trace_id: str | None = None):
        return StreamingResponse(
            _envelope_stream(request, trace_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                     "X-Accel-Buffering": "no"},
        )

    @app.get("/events")
    async def events(trace_id: str | None = None):
        return JSONResponse(snapshot(trace_id))

    @app.get("/api/state")
    async def api_state():
        return JSONResponse(build_state())

    @app.get("/api/decisions")
    async def api_decisions():
        return JSONResponse({"decisions": build_state()["decisions"]})

    @app.post("/api/decisions/{decision_id}")
    async def api_resolve_decision(decision_id: str, request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        action = str(body.get("action", "")).strip().lower()
        text = body.get("text")
        d = resolve_decision(decision_id, action, text if isinstance(text, str) else None)
        if d is None:
            if get_decision(decision_id) is None:
                return JSONResponse({"error": "unknown decision_id"}, status_code=404)
            return JSONResponse(
                {"error": "action must be approve, or edit with non-empty text"},
                status_code=400)
        audit_append("host_decision", d["booking_id"],
                     f"Host {d['status']} the {d['kind'].replace('_', ' ')} reply for "
                     f"{d['guest_name']}. Modelled exposure "
                     f"{d['modelled_exposure_eur']:.2f} EUR.",
                     trace_id=d["trace_id"], degraded=d["degraded"])
        emit("decision_resolved", "done",
             {"decision_id": d["decision_id"], "booking_id": d["booking_id"],
              "kind": d["kind"], "status": d["status"],
              "modelled_exposure_eur": d["modelled_exposure_eur"]},
             trace_id=d["trace_id"])
        return JSONResponse({"decision": d})

    @app.get("/api/audit")
    async def api_audit(limit: str | None = None):
        try:
            n = min(max(int(limit or 200), 1), 500)
        except (TypeError, ValueError):
            n = 200
        return JSONResponse({"audit": audit_read(n)})

    @app.post("/api/runs")
    async def api_runs():
        return JSONResponse(await start_cycle_bg())

    assets = DIST_DIR / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.on_event("startup")
    async def _on_startup() -> None:
        app.state.scheduler_task = asyncio.create_task(_scheduler())

    @app.on_event("shutdown")
    async def _on_shutdown() -> None:
        task = getattr(app.state, "scheduler_task", None)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

    @app.get("/{path:path}")
    async def spa(path: str):
        index = DIST_DIR / "index.html"
        if index.is_file():
            return HTMLResponse(index.read_text(encoding="utf-8"))
        return HTMLResponse(PLACEHOLDER_HTML, status_code=200)

    return app


app = create_app()
