// Requirement IDs: TRN-RES-03, RES-RES-02, TRN-REU-01, GOV-RES-04 | none adapter (DP-B §4.1, §4.6)
// INTERNAL ADAPTER — GOV-REU-03: consumers never import this file.
//
// Implements TRANSPORT=none: no streaming socket at all — subscribe resolves
// immediately via the GET /events JSON fallback path (fetchEventFallback).
// This is the offline-rehearsal route (RES-RES-02 / DEMODRIVE-RES-02): the
// snapshot can come from a static server or the MOCK-05/RES-05 cache while
// delivering envelopes of the IDENTICAL EventEnvelope shape as streaming
// (TRN-06), so no call-site changes when TRANSPORT flips (GOV-REU-01).

import { fetchEventFallback } from "../fallback.js";
import type { EventEnvelope } from "../event-envelope.js";

/** Callbacks shared with the subscriber facade (subset of SubscribeOptions). */
export type NoneSubscribeOptions = {
  /** Fallback endpoint. Default "/events" (no /stream suffix). */
  url?: string;
  /** Override; else resolveApiBase() (missing → same-origin, GOV-RES-02). */
  apiBase?: string;
  /** Optional trace_id filter. */
  traceId?: string;
  onEnvelope?: (env: EventEnvelope) => void;
  onError?: (e: Error) => void;
  /** Fired for envelopes with degraded === true (UI-RES-02 branch). */
  onDegraded?: (env: EventEnvelope) => void;
};

/**
 * Direct-to-fallback subscription: fetches GET /events once and delivers every
 * validated envelope through the SAME callbacks as the SSE adapter — consumers
 * cannot distinguish fallback from streaming at the callback level (§4.6).
 * Never throws unhandled: failures surface via onError only (GOV-RES-04); a
 * call-site may wrap this with DP-A withResilience so the failure enters the
 * RES-03 chain (cache → replay → DegradedResult).
 */
export function subscribeViaNone(opts: NoneSubscribeOptions): () => void {
  let disposed = false;
  void fetchEventFallback({ url: opts.url ?? "/events", apiBase: opts.apiBase, traceId: opts.traceId })
    .then((snapshot) => {
      if (disposed) return;
      for (const envelope of snapshot.events) {
        // Every envelope was already schema-validated inside fetchEventFallback
        // (the one contract, TRN-06) before delivery.
        if (envelope.degraded === true) opts.onDegraded?.(envelope);
        opts.onEnvelope?.(envelope);
      }
    })
    .catch((err: unknown) => {
      if (disposed) return; // closed subscriber never reports (TRN-AC-02 style)
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  return () => {
    disposed = true;
  };
}
