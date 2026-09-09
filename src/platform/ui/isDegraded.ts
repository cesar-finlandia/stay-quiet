// Requirement IDs: UI-RES-02, RES-06, TRN-RES-03 | DP-B §7.2
// Degraded-mode detection + shared banner treatment for all three UI
// components. Detection imports DP-A's type guard — never redefined here
// (RES-06): envelope.degraded === true (top-level marker, UI-RES-02) or a
// full DegradedResult escaped into payload. There is no second error
// channel and no separate "fallback" UI mode (TRN-RES-03 §7.3): when the
// transport fell back non-streaming, done envelopes simply render at once;
// only if those envelopes carry DegradedResult does the banner appear.
import type { EventEnvelope } from "src/platform/transport";
import { isDegradedResult } from "src/resilience";
import type { DegradedResult } from "src/resilience";

/**
 * True when an envelope carries a DegradedResult per DP-A — either flagged at
 * the top level (`degraded === true`) or with the DegradedResult itself as the
 * payload. Single discriminator check per UI-RES-02; never throws.
 */
export function isDegradedEnvelope(e: EventEnvelope): boolean {
  return e.degraded === true || isDegradedResult((e.payload ?? {}) as unknown);
}

/** Extract the DegradedResult carried by an envelope, or null when absent. */
export function degradedResultOf(e: EventEnvelope): DegradedResult | null {
  const payload = (e.payload ?? {}) as unknown;
  if (isDegradedResult(payload)) return payload;
  if (e.degraded !== true || typeof payload !== "object" || payload === null) return null;
  // Top-level flag with fields inlined on payload — normalize minimally.
  const p = payload as Record<string, unknown>;
  return {
    degraded: true,
    reason: typeof p["reason"] === "string" ? p["reason"] : "",
    fallback_source:
      p["fallback_source"] === "secondary_provider" ||
      p["fallback_source"] === "cache" ||
      p["fallback_source"] === "replay"
        ? p["fallback_source"]
        : "none",
    original_error: typeof p["original_error"] === "string" ? p["original_error"] : null,
    data: (p["data"] ?? null) as DegradedResult["data"],
    timestamp: typeof p["timestamp"] === "string" ? p["timestamp"] : e.timestamp,
    version: "1.0.0",
  };
}

export type { DegradedResult };
