// Requirement IDs: RES-06, UI-RES-02, DEP-RES-01, XCUT-08
// DegradedResult typed signal — DP-A §4.3. Single source of truth is the frozen
// contract contracts/degraded-result.schema.json; this module mirrors it as a TS
// type + factory + type guard. Consumers detect degraded mode via the single
// discriminator check `degraded === true` (UI-RES-02). Domain-free (GOV-REU-02).

export type FallbackSource = "secondary_provider" | "cache" | "replay" | "none";

/** DegradedResult — frozen contract contracts/degraded-result.schema.json (DP-A §4.3). */
export type DegradedResult<T = unknown> = {
  degraded: true; // discriminator — UI-RES-02 checks this field
  reason: string;
  fallback_source: FallbackSource;
  original_error: string | null;
  data: T | null;
  timestamp: string; // ISO-8601
  version: "1.0.0";
};

export interface DegradedResultInput<T = unknown> {
  reason: string;
  fallback_source: FallbackSource;
  original_error?: string | null;
  data?: T | null;
}

const DEGRADED_RESULT_VERSION = "1.0.0" as const;

/** Factory: fills timestamp (ISO-8601, UTC) and version per the frozen contract. */
export function makeDegradedResult<T>(input: DegradedResultInput<T>): DegradedResult<T> {
  return {
    degraded: true,
    reason: input.reason,
    fallback_source: input.fallback_source,
    original_error: input.original_error ?? null,
    data: input.data ?? null,
    timestamp: new Date().toISOString(),
    version: DEGRADED_RESULT_VERSION,
  };
}

/**
 * Type guard per UI-RES-02: the ONLY check consumers need is the single
 * discriminator `degraded === true` plus minimal shape. Never throws.
 */
export function isDegradedResult(value: unknown): value is DegradedResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["degraded"] === true &&
    typeof v["reason"] === "string" &&
    typeof v["fallback_source"] === "string" &&
    typeof v["timestamp"] === "string"
  );
}
