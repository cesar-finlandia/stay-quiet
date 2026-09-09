// Requirement IDs: CTX-03, CTX-06, GOV-RES-02
// Budget calculator + warning signal (DP-E §5.1 formula, §5.2 thresholds).
// Pure arithmetic + metadata only: same input+config → byte-identical output
// across runs; no timestamps, no randomness, no I/O on this path.
// Missing/malformed config fields never crash — safe checked-in defaults apply
// (GOV-RES-02, DP-E §11). Zero imports from other chassis components (CTX-REU-01).
import type { Buffer, BufferStatus, ContextBudgetConfig } from "./types.js";
import { budget as profileTokenBudget, countBuffer } from "./token_counter.js";

//#region Checked-in safe defaults (mirror of src/context/defaults.json, DP-E §11)

/** File-level defaults applied when the per-call config omits or corrupts a knob. */
export const CONTEXT_DEFAULTS = {
  model_profile: "generic-heuristic",
  reserved_output: 1024,
  strategy: "sliding-window-pinned",
  warning_threshold: 0.8,
  critical_threshold: 0.95,
} as const;

/** Generic fallback context window when the profile map has no entry and no override (§11). */
export const GENERIC_CONTEXT_WINDOW = 8192;

function clampThreshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/**
 * Fill every omitted/malformed knob with its safe default (GOV-RES-02, §11).
 * Never throws; the returned config is always arithmetically usable.
 */
export function resolveConfig(config?: Partial<ContextBudgetConfig> | null): ContextBudgetConfig {
  const cfg = (config ?? {}) as Partial<ContextBudgetConfig>;
  const modelProfile =
    typeof cfg.model_profile === "string" && cfg.model_profile.length > 0
      ? cfg.model_profile
      : CONTEXT_DEFAULTS.model_profile;
  // context_window override must be a positive integer to win over the profile map.
  const overrideWindow =
    typeof cfg.context_window === "number" && Number.isFinite(cfg.context_window) && cfg.context_window >= 1
      ? Math.floor(cfg.context_window)
      : null;
  const reservedOutput =
    typeof cfg.reserved_output === "number" && Number.isFinite(cfg.reserved_output) && cfg.reserved_output >= 0
      ? Math.floor(cfg.reserved_output)
      : CONTEXT_DEFAULTS.reserved_output;
  return {
    model_profile: modelProfile,
    context_window: overrideWindow,
    reserved_output: reservedOutput,
    strategy: cfg.strategy ?? CONTEXT_DEFAULTS.strategy,
    strategy_options: cfg.strategy_options ?? {},
    warning_threshold: clampThreshold(cfg.warning_threshold, CONTEXT_DEFAULTS.warning_threshold),
    critical_threshold: clampThreshold(cfg.critical_threshold, CONTEXT_DEFAULTS.critical_threshold),
    mutate: cfg.mutate === true,
    compaction: cfg.compaction ?? null,
  };
}

//#endregion

//#region Budget arithmetic (DP-E §5.1)

export type Budget = { context_window: number; reserved_output: number; input_budget: number };

/**
 * Resolve { context_window, reserved_output, input_budget } for a config:
 * context_window = explicit override > tokenizer-profiles.json entry > generic 8192;
 * reserved_output default 1024; input_budget = max(0, context_window - reserved_output).
 * Pure + total: never throws (GOV-RES-02/GOV-RES-04 style).
 */
export function calcBudget(config?: Partial<ContextBudgetConfig> | null): Budget {
  const effective = resolveConfig(config);
  // Single source of truth for contracts/tokenizer-profiles.json is token_counter
  // (DP-E §4.2); it already applies unknown-profile → generic-heuristic/8192 (§11).
  const derived = profileTokenBudget(effective.model_profile, effective.reserved_output);
  // Explicit per-call override wins over the profile map (§5.1 bullet 3).
  const contextWindow = effective.context_window ?? derived.context_window;
  return {
    context_window: Math.max(1, contextWindow),
    reserved_output: derived.reserved_output,
    input_budget: Math.max(0, Math.max(1, contextWindow) - derived.reserved_output),
  };
}

//#endregion

//#region Warning signal (DP-E §5.2)

/**
 * Peek-only status for a buffer: counts tokens, derives utilization and the
 * single CTX-06 warning signal — WITHOUT any truncation. utilization may exceed
 * 1 when the buffer is over budget. Always returns a full BufferStatus.
 */
export function calcStatus(
  buffer: Buffer,
  config?: Partial<ContextBudgetConfig> | null,
): BufferStatus {
  try {
    const effective = resolveConfig(config);
    const b = calcBudget(effective);
    const totalTokens = Array.isArray(buffer) ? countBuffer(buffer, effective.model_profile) : 0;
    const utilization = b.input_budget > 0 ? totalTokens / b.input_budget : totalTokens > 0 ? Infinity : 0;
    return {
      total_tokens: totalTokens,
      input_budget: b.input_budget,
      utilization,
      truncated: false, // peek never truncates (§5.1 "peek without truncation")
      evicted_count: 0,
      warning: classifyWarning(totalTokens, utilization, effective),
      rejected: false,
      strategy: effective.strategy as string,
      model_profile: effective.model_profile,
    };
  } catch {
    // Absolute last resort — status is always emitted (§5.2), never an unhandled throw.
    return {
      total_tokens: 0,
      input_budget: 0,
      utilization: 0,
      truncated: false,
      evicted_count: 0,
      warning: "none",
      rejected: false,
      strategy: CONTEXT_DEFAULTS.strategy,
      model_profile: CONTEXT_DEFAULTS.model_profile,
    };
  }
}

/** Threshold classification per DP-E §5.2 table. Deterministic pure function. */
export function classifyWarning(
  totalTokens: number,
  utilization: number,
  config: Pick<ContextBudgetConfig, "warning_threshold" | "critical_threshold"> & { input_budget?: number },
): "none" | "approaching" | "exceeded" {
  const warningAt = clampThreshold(config.warning_threshold, CONTEXT_DEFAULTS.warning_threshold);
  const criticalAt = clampThreshold(config.critical_threshold, CONTEXT_DEFAULTS.critical_threshold);
  const overBudget =
    typeof config.input_budget === "number" ? totalTokens > config.input_budget : false;
  if (utilization >= criticalAt || overBudget) return "exceeded";
  if (utilization >= warningAt) return "approaching";
  return "none";
}

//#endregion
