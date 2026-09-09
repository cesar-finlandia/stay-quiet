// Requirement IDs: TRN-RES-03, TRN-06, TRN-REU-01, GOV-RES-02, GOV-RES-04 | DP-B §4.6
// Non-streaming fallback (TRN-RES-03) shared between the server collect() path
// (publisher accumulates envelopes per trace; GET /events returns them as one
// synchronous JSON snapshot) and the client fallback fetch (useEventStream uses
// it when SSE fails after one retry). The snapshot reuses the ONE EventEnvelope
// schema — no second contract (TRN-06).
//
// RES-03 integration note (DP-A): a call-site may wrap the transport consumer
// with `withResilience` from src/resilience so a streaming failure enters the
// RES-03 chain (cache → replay → DegradedResult). This module only guarantees
// that the raw fallback data is available and schema-valid; it never throws
// unhandled — callers catch and surface via their own onError channels
// (GOV-RES-04).

import { readFileSync } from "node:fs";
import { validate } from "../../resilience/validate.js";
import type { EventEnvelope } from "./event-envelope.js";

/** Synchronous final response body served by GET /events (plan §4.6). */
export interface FallbackSnapshot {
  status: "complete";
  trace_id: string;
  events: EventEnvelope[];
  degraded: boolean;
}

let cachedSchema: object | null = null;
function loadEnvelopeSchema(): object {
  if (!cachedSchema) {
    const url = new URL("../../../contracts/event-envelope.schema.json", import.meta.url);
    cachedSchema = JSON.parse(readFileSync(url, "utf8")) as object;
  }
  return cachedSchema;
}

/**
 * API_BASE resolution (DP-B §8): VITE_API_BASE / API_BASE env; missing → ""
 * (same-origin, GOV-RES-02 — never a crash). Guarded feature detection keeps
 * this importable from both browser bundles and Node test runtimes.
 */
export function resolveApiBase(): string {
  try {
    const meta = import.meta as unknown as { env?: { VITE_API_BASE?: string } };
    if (meta.env?.VITE_API_BASE) return meta.env.VITE_API_BASE.replace(/\/$/, "");
  } catch {
    /* non-module runtime — fall through */
  }
  if (typeof process !== "undefined" && process.env?.API_BASE) {
    return process.env.API_BASE.replace(/\/$/, "");
  }
  return ""; // same-origin
}

export type FetchFallbackOptions = {
  /** Fallback endpoint. Default "/events" (no /stream suffix, plan §4.6). */
  url?: string;
  /** Override; else resolved via resolveApiBase() (missing → same-origin). */
  apiBase?: string;
  /** Optional trace_id filter appended as ?trace_id=… */
  traceId?: string;
};

/** Build an API_BASE-aware absolute-or-same-origin URL for fetch(). */
export function buildFallbackUrl(opts: FetchFallbackOptions): string {
  const path = opts.url ?? "/events";
  const withTrace = opts.traceId
    ? `${path}${path.includes("?") ? "&" : "?"}trace_id=${encodeURIComponent(opts.traceId)}`
    : path;
  const base = opts.apiBase !== undefined ? opts.apiBase : resolveApiBase();
  return `${base}${withTrace}`;
}

/**
 * Client-side TRN-RES-03 fetch: GET /events once and validate every envelope
 * against the single EventEnvelope contract BEFORE returning, so consumers get
 * the identical shape as the streaming path (TRN-06 / plan §10.6). Envelopes
 * are returned sorted by sequence for atomic population.
 *
 * Throws Error on network/schema failure — callers catch (useEventStream,
 * adapters/none.ts) and degrade gracefully per GOV-RES-04; a call-site may
 * instead route that error into DP-A withResilience (cache → replay →
 * DegradedResult) so a streaming failure enters the RES-03 chain.
 */
export async function fetchEventFallback(opts: FetchFallbackOptions = {}): Promise<FallbackSnapshot> {
  const res = await fetch(buildFallbackUrl(opts), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`fallback GET /events failed: HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`fallback GET /events returned malformed JSON: ${String(err)}`);
  }
  return parseSnapshot(body);
}

/** Validate a decoded GET /events body against the one envelope schema. */
export function parseSnapshot(body: unknown): FallbackSnapshot {
  const raw = body as { status?: unknown; trace_id?: unknown; events?: unknown; degraded?: unknown };
  if (!raw || raw.status !== "complete" || typeof raw.trace_id !== "string" || !Array.isArray(raw.events)) {
    throw new Error("fallback snapshot has unexpected shape (expected status/trace_id/events)");
  }
  const schema = loadEnvelopeSchema();
  const events: EventEnvelope[] = raw.events.map((entry, i) => {
    const result = validate(schema, entry);
    if (!result.valid) {
      throw new Error(`fallback event ${i} failed envelope validation: ${JSON.stringify(result.errors)}`);
    }
    return entry as EventEnvelope;
  });
  events.sort((a, b) => a.sequence - b.sequence); // atomic, sequence-ordered population
  return {
    status: "complete",
    trace_id: raw.trace_id,
    events,
    degraded: raw.degraded === true || events.some((env) => env.degraded === true),
  };
}
