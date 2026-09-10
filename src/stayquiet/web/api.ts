// StayQuiet UI — the only place the browser talks to the backend.
// Every function resolves, never throws: a failed fetch returns a safe empty shape
// so the interface degrades to its empty states instead of a blank page.
//
// NOTE on the envelope import: the type comes from the generated module
// src/platform/transport/event-envelope.js via `import type` (DP-UI §4), NOT from
// the transport barrel — the barrel's runtime graph pulls node:fs/node:crypto/
// node:http into the browser bundle (§0). §3.2's skeleton line naming the barrel
// is superseded by §4; `import type` erases at compile time either way.
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";

export type Decision = {
  decision_id: string;
  run_id: string;
  trace_id: string;
  booking_id: string;
  guest_name: string;
  listing_name: string;
  kind: string;
  summary: string;
  clause_ids: string[];
  draft_text: string;
  checklist: string[];
  modelled_exposure_eur: number;
  status: string;
  created_at: string;
  resolved_at: string | null;
  final_text: string | null;
  degraded: boolean;
};

export type RunRecord = {
  run_id: string;
  trace_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  bookings_scanned: number;
  bookings_affected: number;
  changed_clauses: string[];
  decisions: string[];
  quiet_actions: number;
  degraded: boolean;
  elapsed_ms: number;
  tokens: number;
  summary: string;
};

export type AuditEntry = {
  entry_id: string;
  at: string;
  action: string;
  booking_id: string;
  detail: string;
  trace_id: string;
  degraded: boolean;
};

export type AppState = {
  synthetic: boolean;
  run: RunRecord | null;
  cycle_running: boolean;
  decisions: Decision[];
  audit: AuditEntry[];
  cost: {
    total_tokens: number;
    request_count: number;
    estimated_cost_usd: number | null;
    budget_tokens: number;
    utilization: number;
    warnings: string[];
  };
  events: EventEnvelope[];
  latest_sequence: number;
  config: {
    demo_mode: boolean;
    model_id: string;
    region: string;
    cycle_interval_s: number;
    track: string;
    stack: string;
  };
};

/** The empty state rendered before the first successful poll, and after a failed one. */
export const EMPTY_STATE: AppState = {
  synthetic: true,
  run: null,
  cycle_running: false,
  decisions: [],
  audit: [],
  cost: {
    total_tokens: 0,
    request_count: 0,
    estimated_cost_usd: null,
    budget_tokens: 0,
    utilization: 0,
    warnings: [],
  },
  events: [],
  latest_sequence: 0,
  config: {
    demo_mode: false,
    model_id: "",
    region: "",
    cycle_interval_s: 0,
    track: "Professional Agents",
    stack: "Strands Agents SDK for Python on Amazon Bedrock",
  },
};

/** GET /api/state. Never throws; returns EMPTY_STATE on any failure. */
export async function fetchState(): Promise<AppState> {
  try {
    const r = await fetch("/api/state", { headers: { accept: "application/json" } });
    if (!r.ok) return EMPTY_STATE;
    const j = (await r.json()) as Partial<AppState>;
    return { ...EMPTY_STATE, ...j };
  } catch {
    return EMPTY_STATE;
  }
}

/** POST /api/decisions/{id} with {action:"approve"} or {action:"edit", text}. */
export async function resolveDecision(
  decisionId: string,
  action: "approve" | "edit",
  text?: string,
): Promise<Decision | null> {
  try {
    const r = await fetch(`/api/decisions/${encodeURIComponent(decisionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "edit" ? { action, text } : { action }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { decision?: Decision };
    return (j.decision as Decision) ?? null;
  } catch {
    return null;
  }
}

/** POST /api/runs. Returns true when a cycle was started. */
export async function startRun(): Promise<boolean> {
  try {
    const r = await fetch("/api/runs", { method: "POST" });
    if (!r.ok) return false;
    const j = (await r.json()) as { started?: boolean };
    return Boolean(j.started);
  } catch {
    return false;
  }
}

export type StreamStatus = "connecting" | "open" | "closed" | "error";

/** True when `value` carries the five required envelope fields with the right types. */
export function isEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["step_id"] === "string" &&
    typeof v["status"] === "string" &&
    typeof v["sequence"] === "number" &&
    typeof v["timestamp"] === "string" &&
    typeof v["payload"] === "object" &&
    v["payload"] !== null
  );
}

/**
 * Subscribe to GET /events/stream and deliver each envelope to `onEnvelope`.
 *
 * This exists because the pre-existing useEventStream / createSubscriber cannot run
 * in a browser (§0): their module graph statically imports node:fs, node:crypto and
 * node:http, and their per-envelope validation needs ajv through node:module. This is
 * the browser-native equivalent — EventSource, the same `event: envelope` frame name
 * the backend emits, and a small structural guard in place of JSON Schema validation.
 *
 * Returns an unsubscribe function. Never throws.
 */
export function subscribeEnvelopes(handlers: {
  onEnvelope: (env: EventEnvelope) => void;
  onStatus: (status: StreamStatus) => void;
}): () => void {
  const { onEnvelope, onStatus } = handlers;
  const noop = (): void => undefined;
  try {
    onStatus("connecting");
    let es: EventSource;
    try {
      es = new EventSource("/events/stream");
    } catch {
      onStatus("error");
      return noop;
    }
    es.addEventListener("open", () => onStatus("open"));
    es.addEventListener("envelope", (evt) => {
      try {
        const parsed: unknown = JSON.parse((evt as MessageEvent).data);
        if (isEnvelope(parsed)) onEnvelope(parsed);
      } catch {
        // One malformed frame must never stop the stream.
      }
    });
    es.onerror = () => onStatus(es.readyState === 2 ? "closed" : "connecting");
    return () => {
      try {
        es.close();
      } catch {
        // Already closed.
      }
      onStatus("closed");
    };
  } catch {
    try {
      onStatus("error");
    } catch {
      // Handlers must never break the caller.
    }
    return noop;
  }
}
