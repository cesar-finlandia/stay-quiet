# Platform Transport (TRN-01..06)

Publish/subscribe streaming primitives for EventEnvelope traffic.

- `publisher.ts` — backend `createPublisher()` (DP-B §4.2.1). Validates every
  envelope via RES-04 before emit; throws `EnvelopeValidationError` on malformed
  envelopes; never inspects payload keys (TRN-REU-02); accepts any stepId at any
  time (TRN-REU-01).
- `subscriber.ts` / `useEventStream.ts` — frontend `createSubscriber()` /
  `useEventStream()` (§4.2.2). Both validate after receive.
- `adapters/sse.ts` — INTERNAL adapter (GOV-REU-03): application code imports
  only from this package root, never `adapters/*`.
- `adapters/websocket.ts` — INTERNAL opt-in WS adapter (TRN-03): same facade,
  identical `JSON.stringify(envelope)` payload, zero extra deps (GOV-MIN-01).
- `adapters/none.ts` — INTERNAL TRANSPORT=none adapter: direct-to-fallback via
  GET /events JSON (offline rehearsal, RES-RES-02).
- `fallback.ts` — TRN-RES-03 non-streaming fallback (§4.6): server-side
  `collect()` snapshots live on the publisher; this module holds the shared
  `FallbackSnapshot` type and the client-side `fetchEventFallback()` used by
  `useEventStream` when SSE fails after one retry. Same EventEnvelope contract
  — no second format (TRN-06). A call-site may wrap consumers with DP-A
  `withResilience` so streaming failure enters the RES-03 chain.
- `stream_router.py` / `stream_router.ts` — illustrative route wiring only:
  GET `/events/stream` → SSE fanout, GET `/events` → fallback snapshot.

## Reconnect contract (`TRN-RES-02`, verbatim per DP-B §4.5)

> A client that disconnects and reconnects **starts a fresh subscription**. No
> server-side replay is guaranteed. The `sequence` field is the ordering hint
> for future replay; v1 does not replay past envelopes on reconnect.

Concretely: `reconnect()` (and the one-shot auto-reconnect when
`fallback:"auto"`) opens a brand-new subscription — the server returns the new
stream from that point forward, not historical replay. The client resets its
envelope buffer on reconnect unless it preserved its own copy. `sequence` is
the future replay extension point (e.g. additive `Last-Event-ID` handling in a
later version); it is not used for replay in v1.

## Transport selection (`TRN-03`, DP-B §4.1/§8)

`config/transport.json` (`{"transport":"sse"}`) + `TRANSPORT` env override pick
the adapter: `sse` (default) | `websocket` | `none`. Unknown/missing values →
safe default `sse` + `console.warn`, never a startup crash (GOV-RES-02).
Switching requires no call-site edit (GOV-REU-01) — facades only. Missing
`API_BASE` / `VITE_API_BASE` → same-origin. With `fallback:"auto"` (default),
SSE failure after one retry downgrades to the non-streaming snapshot
(`TRN-RES-03`); consumers see the same `envelopes: EventEnvelope[]` either way.
