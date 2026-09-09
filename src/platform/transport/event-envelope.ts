// AUTO-GENERATED — do not edit; source: contracts/event-envelope.schema.json
// Requirement IDs: TRN-01, TRN-02, TRN-06

/**
 * Generic live-process event — TRN-01/TRN-02/TRN-06. No domain noun is a first-class field; payload is arbitrary.
 */
export interface EventEnvelope {
  /**
   * Opaque kebab-case step identifier. No semantics enforced. Examples: retrieval-pass, widget-overview, synthesis.
   */
  step_id: string;
  /**
   * Lifecycle value for the step. started → (0..n streaming) → done|error. No other values permitted.
   */
  status: "started" | "streaming" | "done" | "error";
  /**
   * Arbitrary domain payload. Envelope never interprets it. May be {} or contain delta/content degraded markers. No domain noun at envelope top-level.
   */
  payload: {
    [k: string]: unknown;
  };
  /**
   * Producer ISO-8601 UTC timestamp, e.g. 2026-03-11T14:22:05.123Z
   */
  timestamp: string;
  /**
   * Monotone per-trace sequence counter. Used for ordering and optional reconnect replay extension. No gap tolerance required in v1.
   */
  sequence: number;
  /**
   * Optional correlation id across steps of one run. UUID v4.
   */
  trace_id?: string;
  /**
   * True only if payload is (or contains) a DegradedResult per DP-A contracts/degraded-result.schema.json. UI-RES-02 checks degraded===true. Defaults to false.
   */
  degraded?: boolean;
}

// From degraded-result.schema.json (referenced by $defs.DegradedResultRef — TRN-06)
export interface DegradedResult {
  /**
   * discriminator — UI-RES-02 checks this field
   */
  degraded: true;
  reason: string;
  /**
   * which step ultimately produced data, or none
   */
  fallback_source: "secondary_provider" | "cache" | "replay" | "none";
  original_error?: string | null;
  /**
   * last successful fallback payload if any; null if none
   */
  data?:
    | {
        [k: string]: unknown;
      }
    | unknown[]
    | string
    | number
    | boolean
    | null;
  timestamp: string;
  version: "1.0.0";
}

export type DegradedResultRef = DegradedResult;
