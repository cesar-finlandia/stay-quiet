// Requirement IDs: TRN-04, TRN-01, TRN-02, TRN-05, TRN-06, TRN-RES-01, GOV-REU-03, TRN-REU-01/02
// Backend publish primitive (DP-B §4.2.1). Transport-agnostic facade: callers
// never import adapters (GOV-REU-03). Every envelope is validated via RES-04
// against contracts/event-envelope.schema.json BEFORE emit; a malformed
// envelope throws EnvelopeValidationError — the publisher never silently emits.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { validate, ValidationError } from "../../resilience/validate.js";
import type { EventEnvelope } from "./event-envelope.js";
import type { FallbackSnapshot } from "./fallback.js";
import { SseHub } from "./adapters/sse.js";
import { WebSocketHub } from "./adapters/websocket.js";
import type { WsSocketLike } from "./adapters/websocket.js";

/** Lifecycle value for step.status (TRN-01 schema enum). */
export type EnvelopeStatus = "started" | "streaming" | "done" | "error";

/** Frozen contract source (TRN-06) — loaded once from disk. */
let cachedSchema: object | null = null;
function loadEnvelopeSchema(): object {
  if (!cachedSchema) {
    const url = new URL("../../../contracts/event-envelope.schema.json", import.meta.url);
    cachedSchema = JSON.parse(readFileSync(url, "utf8")) as object;
  }
  return cachedSchema;
}

/** Thrown when an envelope fails RES-04 schema validation before emit. */
export class EnvelopeValidationError extends Error {
  readonly errors: ValidationError[];
  constructor(message: string, errors: ValidationError[]) {
    super(message);
    this.name = "EnvelopeValidationError";
    this.errors = errors;
  }
}

export type PublishOptions = {
  /** kebab-case step id — any value accepted at any time (TRN-REU-01). */
  stepId: string;
  status: EnvelopeStatus;
  /** Arbitrary domain payload — publisher never inspects its keys (TRN-REU-02). */
  payload?: Record<string, unknown>;
  /** uuid; auto-generated when absent. */
  traceId?: string;
  /** default false */
  degraded?: boolean;
};

export interface Publisher {
  /**
   * Emit one EventEnvelope. Validates via RES-04 before emitting; throws
   * EnvelopeValidationError if the envelope itself is malformed (not payload
   * shape). Resolves after the transport flush (cooperative backpressure).
   */
  publish(opts: PublishOptions): Promise<void>;
  /** Convenience: publish one incremental delta (status "streaming", TRN-05). */
  publishDelta(stepId: string, delta: string, index: number, traceId?: string): Promise<void>;
  /** Close this trace — no further envelopes; cleans up connections internally. */
  close(): Promise<void>;
  /** Current sequence counter (for diagnostics). */
  readonly sequence: number;
}

/**
 * Concrete SSE-backed publisher. The extra asSseStream member is wiring-only
 * (backend routers / local test servers); application code sticks to the
 * Publisher interface above.
 */
export interface SsePublisher extends Publisher {
  /** Attach one HTTP response as an SSE event stream (router/test wiring only). */
  asSseStream(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void;
  readonly connectionCount: number;
}

/**
 * TRN-RES-03 collect support on the publisher path (plan §4.6): emitted,
 * already-validated envelopes accumulate in memory per trace so GET /events
 * (no /stream suffix) can serve the synchronous final snapshot.
 */
export interface CollectablePublisher extends SsePublisher {
  /**
   * Snapshot for one trace. `traceId` omitted → most recently published trace.
   * Returns null when nothing was published yet. The `events` array is the SAME
   * EventEnvelope contract — no second format (TRN-06); also consumable as a
   * RES-05 cache snapshot (MOCK-05/DEMODRIVE-01 path).
   */
  collect(traceId?: string): FallbackSnapshot | null;
  /** Attach one accepted ws-like socket (host `upgrade` wiring only). */
  asWebSocket(socket: WsSocketLike): void;
  readonly wsConnectionCount: number;
}

type TransportKind = "sse" | "websocket" | "none";

/** TRANSPORT knob: config/transport.json + env override; safe fallback "sse" + warn (GOV-RES-02). */
export function resolveTransport(transport?: TransportKind | string): TransportKind {
  let raw = transport;
  if (raw === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const cfg = JSON.parse(
        readFileSync(new URL("../../../config/transport.json", import.meta.url), "utf8"),
      ) as { transport?: string };
      raw = process.env.TRANSPORT ?? cfg.transport ?? undefined;
    } catch {
      raw = process.env.TRANSPORT ?? undefined; // missing/malformed config → env or default
    }
  }
  if (raw === "websocket") return "websocket"; // adapter lands in a later step; caller warns below
  if (raw === "none" || raw === "sse") return raw;
  if (raw !== undefined && raw !== "sse") console.warn(`[transport] unknown TRANSPORT "${raw}" → falling back to "sse"`);
  return "sse";
}

class SsePublisherImpl implements CollectablePublisher {
  private seq = 0;
  private readonly hub = new SseHub();
  private readonly wsHub = new WebSocketHub(); // TRANSPORT=websocket opt-in path (§4.1)
  private closed = false;
  // TRN-RES-03: per-trace in-memory accumulation of validated envelopes (§4.6).
  // Demo-scale traces only; the map is keyed by trace_id, insertion order = publish order.
  private readonly collected = new Map<string, EventEnvelope[]>();
  private lastTraceId: string | null = null;

  get sequence(): number {
    return this.seq;
  }

  get connectionCount(): number {
    return this.hub.size;
  }

  asSseStream(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    this.hub.attach(req, res);
  }

  asWebSocket(socket: WsSocketLike): void {
    this.wsHub.attach(socket);
  }

  get wsConnectionCount(): number {
    return this.wsHub.size;
  }

  async publish(opts: PublishOptions): Promise<void> {
    const envelope: EventEnvelope = {
      step_id: opts.stepId,
      status: opts.status,
      payload: opts.payload ?? {},
      timestamp: new Date().toISOString(),
      sequence: this.seq,
      // uuid correlation id — auto-generated when caller omits it (TRN-04)
      trace_id: opts.traceId ?? randomUUID(),
      ...(opts.degraded !== undefined ? { degraded: opts.degraded } : {}),
    };

    // RES-04 gate before emit — never silently emits malformed envelopes.
    const result = validate(loadEnvelopeSchema(), envelope);
    if (!result.valid) {
      throw new EnvelopeValidationError(
        `event envelope failed schema validation: ${JSON.stringify(result.errors)}`,
        result.errors,
      );
    }

    this.seq += 1;

    // TRN-RES-03: record every validated envelope for the collect() snapshot —
    // independent of which adapter actually delivers it (sse/websocket/none).
    const traceKey = envelope.trace_id; // always set by publish(); type allows undefined
    if (traceKey !== undefined) {
      const bucket = this.collected.get(traceKey) ?? [];
      bucket.push(envelope);
      this.collected.set(traceKey, bucket);
      this.lastTraceId = traceKey;
    }

    if (this.closed) return; // closed trace emits nothing further, resolves normally
    await this.emit(envelope);
  }

  collect(traceId?: string): FallbackSnapshot | null {
    const id = traceId ?? this.lastTraceId;
    if (!id) return null;
    const events = [...(this.collected.get(id) ?? [])];
    return {
      status: "complete",
      trace_id: id,
      events,
      degraded: events.some((env) => env.degraded === true),
    };
  }

  async publishDelta(stepId: string, delta: string, index: number, traceId?: string): Promise<void> {
    // Optional traceId keeps deltas inside one TRN-RES-03 collect() trace.
    await this.publish({ stepId, status: "streaming", payload: { delta, index }, traceId });
  }

  private async emit(envelope: EventEnvelope): Promise<void> {
    const kind = resolveTransport();
    if (kind === "websocket") {
      await this.wsHub.fanout(envelope); // identical JSON payload, TRN-06/GOV-REU-01
      return;
    }
    if (kind === "none") return; // TRN-RES-03 collect-only path; validation already done
    await this.hub.fanout(envelope);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.hub.close(), this.wsHub.close()]);
  }
}

/** Factory — selects SSE or WS adapter by config/env (default "sse", TRN-03). */
export function createPublisher(transport?: "sse" | "websocket"): CollectablePublisher {
  resolveTransport(transport);
  return new SsePublisherImpl();
}
