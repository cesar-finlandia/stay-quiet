// Requirement IDs: CTX-01, CTX-02, CTX-03, CTX-06
// Type shapes for the Context & Conversation Buffer Manager (DP-E §3.1–§3.4).
// Provider-agnostic: no domain noun is a first-class field (CTX-01).
// Mirrors contracts/message.schema.json and contracts/context-budget.schema.json
// (JSON Schema draft 2020-12) as TypeScript types; validation of wire input is
// done against the schemas, these types describe the in-memory domain.

//#region Message & Buffer (DP-E §3.1)

/** Frozen role enum — adding a role is MINOR, renaming is MAJOR. */
export type Role = "system" | "user" | "assistant" | "tool";

export type MessageMetadata = {
  /** Creation time ISO-8601. Optional; ordering diagnostics only, never truncation priority. */
  timestamp?: string;
  /** Default false. If true, truncation strategies must never evict this entry (CTX-04). */
  pinned?: boolean;
  /** 0..100, default 0. Higher priority retained preferentially where a strategy supports it. */
  priority?: number;
  /** Optional stable id (kebab-case); for caller correlation, not used by truncation. */
  id?: string;
};

/**
 * Provider-agnostic buffer entry — CTX-01.
 * `token_count` is an optional cache (CTX-02 §4.6): when present and the
 * model_profile is unchanged, counting uses it instead of recomputing.
 */
export type Message = {
  role: Role;
  content: string;
  metadata?: MessageMetadata;
  token_count?: number | null; // cached token count under active model_profile
};

/** Ordered list; index 0 = oldest, last = most recent. Order is the only structural invariant. */
export type Buffer = Message[];

//#endregion

//#region Budget config (DP-E §3.4 — ContextBudgetConfig)

export type TruncationStrategy =
  | "sliding-window-pinned"
  | "keep-last-n"
  | "extension-only";

/**
 * All knobs live here (GOV-RES-02): no code change, no redeploy.
 * Missing/malformed fields → warn + safe default from src/context/defaults.json.
 */
export type ContextBudgetConfig = {
  /** Key into contracts/tokenizer-profiles.json — selects tokenizer + context_window. Required. */
  model_profile: string;
  /** Override context size; null/absent resolves from tokenizer-profiles.json via model_profile. */
  context_window?: number | null;
  /** Tokens reserved for generation; default 1024. */
  reserved_output?: number;
  /** CTX-04 strategy name; default sliding-window-pinned. */
  strategy?: TruncationStrategy;
  /** Per-strategy knobs, e.g. keep-last-n { n: number }. */
  strategy_options?: Record<string, unknown>;
  /** utilization >= threshold → warning:"approaching"; default 0.8. */
  warning_threshold?: number;
  /** utilization >= critical or total > budget → warning:"exceeded"; default 0.95. */
  critical_threshold?: number;
  /** Default false — side-effect-free (new array); true allows in-place truncation (CTX-RES-02). */
  mutate?: boolean;
  /** CTX-05 extension slot — optional CompactionFn config; null means disabled. */
  compaction?: Record<string, unknown> | null;
};

//#endregion

//#region Status & fit result (DP-E §3.2)

/** Single checkable warning signal for CTX-06; sole status shape of fit()/append(). */
export type BufferStatus = {
  total_tokens: number; // sum of token counts for returned buffer
  input_budget: number; // context_window - reserved_output
  utilization: number; // total_tokens / input_budget (may exceed 1 pre-fit)
  truncated: boolean; // true if any message was evicted
  evicted_count: number; // how many messages removed
  warning: "none" | "approaching" | "exceeded"; // CTX-06 signal
  rejected: boolean; // CTX-AC-03: true only if single message > budget and rejected
  reason?: string; // present when rejected or warning==="exceeded"
  strategy: string; // name of strategy applied (e.g. "sliding-window-pinned")
  model_profile: string; // which profile's tokenizer was used
};

/** Sole output shape of fit() and append() (DP-E §3.2, §3.4). */
export type FitResult = {
  buffer: Buffer; // budget-fitted buffer (new array unless mutate:true)
  status: BufferStatus; // §5.2 signal
};

//#endregion
