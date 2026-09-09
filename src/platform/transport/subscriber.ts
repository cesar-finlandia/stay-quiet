// Requirement IDs: TRN-04, TRN-05, TRN-06, TRN-RES-02 | FE subscribe primitive (DP-B §4.2.2)
// Low-level factory (Vite / non-React usage / DEMODRIVE). Consumes the same
// EventEnvelope contract (TRN-06); validates each received envelope via RES-04
// after receive (§3.5). Never imports adapters (GOV-REU-03).

import { readFileSync } from "node:fs";
import { validate } from "../../resilience/validate.js";
import { resolveApiBase } from "./fallback.js";
import { subscribeViaNone } from "./adapters/none.js";
import type { EventEnvelope } from "./event-envelope.js";

let cachedSchema: object | null = null;
function loadEnvelopeSchema(): object {
  if (!cachedSchema) {
    const url = new URL("../../../contracts/event-envelope.schema.json", import.meta.url);
    cachedSchema = JSON.parse(readFileSync(url, "utf8")) as object;
  }
  return cachedSchema;
}

export type SubscribeOptions = {
  /** Stream endpoint. Default "/events/stream" (same-origin / API_BASE-relative). */
  url?: string;
  /** Optional trace_id filter appended as ?trace_id=… */
  traceId?: string;
  /** Override; else resolved from config/transport.json + TRANSPORT env. */
  transport?: "sse" | "websocket" | "none";
  /** "auto" = try SSE then non-streaming fallback (TRN-RES-03); "none" disables. */
  fallback?: "auto" | "none";
  /** Override; else resolveApiBase() — missing → same-origin (GOV-RES-02). */
  apiBase?: string;
  onEnvelope?: (env: EventEnvelope) => void;
  onError?: (e: Error) => void;
  /** Fired for envelopes with degraded === true (UI-RES-02 branch). */
  onDegraded?: (env: EventEnvelope) => void;
};

export interface Subscriber {
  close(): void;
  readonly readyState: "connecting" | "open" | "closed";
}

function resolveUrl(url: string | undefined, traceId: string | undefined, apiBase: string): string {
  const base = `${apiBase}${url ?? "/events/stream"}`; // missing API_BASE → same-origin
  if (!traceId) return base;
  return `${base}${base.includes("?") ? "&" : "?"}trace_id=${encodeURIComponent(traceId)}`;
}

/** Factory — opens an SSE subscription delivering validated envelopes. */
export function createSubscriber(opts: SubscribeOptions = {}): Subscriber {
  const apiBase = opts.apiBase !== undefined ? opts.apiBase : resolveApiBase();

  // TRANSPORT=none (TRN-RES-03 / RES-RES-02): no streaming socket — deliver via
  // the GET /events fallback adapter immediately. Identical envelope callbacks.
  if (opts.transport === "none") {
    let readyState: Subscriber["readyState"] = "open"; // fetch path has no handshake phase
    const cancel = subscribeViaNone({
      url: opts.url,
      apiBase,
      traceId: opts.traceId,
      onEnvelope: (env) => {
        if (env.degraded === true) opts.onDegraded?.(env);
        opts.onEnvelope?.(env);
      },
      onError: (e) => {
        readyState = "closed";
        opts.onError?.(e);
      },
    });
    return {
      close() {
        readyState = "closed";
        cancel();
      },
      get readyState() {
        return readyState;
      },
    };
  }

  let readyState: Subscriber["readyState"] = "connecting";
  let source: EventSource | null = null;

  try {
    source = new EventSource(resolveUrl(opts.url, opts.traceId, apiBase));

    source.onopen = () => {
      readyState = "open";
    };

    // Server frames every envelope as `event: envelope` (DP-B §4.3). Node's
    // EventSource types the listener as (evt: Event); narrow inside.
    source.addEventListener(
      "envelope",
      ((evt: MessageEvent) => {
      readyState = "open";
      let parsed: unknown;
      const raw: string = typeof evt.data === "string" ? evt.data : String(evt.data);
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (err) {
        opts.onError?.(new Error(`malformed envelope JSON: ${String(err)}`));
        return;
      }
      const result = validate(loadEnvelopeSchema(), parsed);
      if (!result.valid) {
        opts.onError?.(new Error(`envelope failed schema validation: ${JSON.stringify(result.errors)}`));
        return;
      }
      const envelope = parsed as EventEnvelope;
      if (envelope.degraded === true) opts.onDegraded?.(envelope);
      opts.onEnvelope?.(envelope);
      }) as EventListener,
    );

    source.onerror = () => {
      // No auto-retry here — reconnect policy lives in useEventStream (TRN-RES-02).
      readyState = source && source.readyState === 2 ? "closed" : "connecting";
      opts.onError?.(new Error("event stream error"));
    };
  } catch (err) {
    readyState = "closed";
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    close() {
      readyState = "closed";
      source?.close();
      source = null;
    },
    get readyState() {
      return readyState;
    },
  };
}
