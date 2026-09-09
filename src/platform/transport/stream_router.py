# Requirement IDs: TRN-02, TRN-03, GOV-RES-01 | Backend route wiring (DP-B §4.2.1)
# ILLUSTRATIVE WIRING — shows how the FastAPI backend exposes the SSE stream at
# GET /events/stream with media_type text/event-stream. The Python publisher
# mirrors src/platform/transport/publisher.ts (same EventEnvelope contract,
# TRN-06 single source of truth); isolation per connection (TRN-RES-01) keeps a
# broken client from crashing the BE process (GOV-RES-01).
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

_SSE_HEADERS = {"Cache-Control": "no-cache", "Connection": "keep-alive"}


class SseFanout:
    """Minimal SSE hub — one queue per connected client (TRN-RES-01)."""

    def __init__(self) -> None:
        self._queues: list[asyncio.Queue[dict[str, Any]]] = []

    def attach(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._queues.append(q)
        return q

    def detach(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        if q in self._queues:
            self._queues.remove(q)

    async def publish(self, envelope: dict[str, Any]) -> None:
        # allSettled-style isolation: a full/dead queue is dropped, never raised.
        for q in list(self._queues):
            try:
                q.put_nowait(envelope)
            except Exception:  # noqa: BLE001 - degrade safely (GOV-RES-01)
                self.detach(q)


HUB = SseFanout()


async def _stream(request: Request) -> AsyncIterator[str]:
    q = HUB.attach()
    try:
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                break
            envelope = await asyncio.wait_for(q.get(), timeout=15.0)
            yield f"id: {envelope['sequence']}\nevent: envelope\ndata: {json.dumps(envelope)}\n\n"
    except asyncio.TimeoutError:
        yield ": keepalive\n\n"  # comment frame as SSE heartbeat
    finally:
        HUB.detach(q)


@router.get("/events/stream")
async def events_stream(request: Request) -> StreamingResponse:
    return StreamingResponse(_stream(request), media_type="text/event-stream", headers=_SSE_HEADERS)


async def publish(step_id: str, status: str, payload: dict[str, Any] | None = None,
                  sequence: int = 0, trace_id: str | None = None) -> None:
    """Engine-facing helper mirroring Publisher.publish (§4.2.1)."""
    envelope: dict[str, Any] = {
        "step_id": step_id,
        "status": status,
        "payload": payload or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "sequence": sequence,
        "trace_id": trace_id or str(uuid.uuid4()),
    }
    # RES-04 schema validation happens before emit in the real publisher; this
    # illustrative route only demonstrates the fanout attachment.
    await HUB.publish(envelope)
