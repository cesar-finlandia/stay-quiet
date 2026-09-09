// Requirement IDs: CTX-04, CTX-RES-02
// Strategy interface + registry for mechanical truncation strategies (DP-E §6 preamble, §6.3).
// A strategy operates ONLY on metadata (pinned/priority) and token counts supplied via
// StrategyContext — never on message content semantics (CTX-04 content-oblivious).
// Deterministic and side-effect-free by default (CTX-RES-02): strategies return new arrays
// and never mutate the input buffer or its Message objects when config.mutate is false.
import { budget as calcTokenBudget } from "../token_counter.js";
import type { Buffer, ContextBudgetConfig, Message } from "../types.js";

/**
 * Resolve the effective input budget for a strategy run (DP-E §6.1 preamble:
 * `budget = ctx.config.input_budget or calcBudget(ctx.config).input_budget`).
 * An explicitly resolved numeric `input_budget` on the effective config wins;
 * otherwise arithmetic per §5.1 with any config.context_window override applied.
 * Pure + deterministic; never throws.
 */
export function resolveInputBudget(config: ContextBudgetConfig): number {
  const override = (config as unknown as { input_budget?: number }).input_budget;
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(0, Math.floor(override));
  }
  const derived = calcTokenBudget(config.model_profile, config.reserved_output);
  const cw = config.context_window;
  if (typeof cw === "number" && Number.isFinite(cw) && cw >= 1) {
    return Math.max(0, Math.floor(cw) - derived.reserved_output);
  }
  return derived.input_budget;
}

//#region Strategy contract (DP-E §6 preamble)

/** Services a strategy may use; counting functions are closed over the active model_profile. */
export type StrategyContext = {
  config: ContextBudgetConfig;
  /** Total token count of a buffer under the active model_profile. */
  countBuffer: (buffer: Buffer) => number;
  /** Token count of one message (framing overhead included) under the active model_profile. */
  countMessage: (msg: Message) => number;
};

export interface Strategy {
  /** Stable registry name, e.g. "sliding-window-pinned". */
  readonly name: string;
  /**
   * Deterministic, side-effect-free unless config.mutate===true.
   * Input buffer is never mutated when mutate===false (default).
   * Returns fitted buffer (new array) + evicted messages for diagnostics.
   * Never throws — degenerate cases are returned as data for the outer fit() layer (§8).
   */
  fit(buffer: Buffer, ctx: StrategyContext): { buffer: Buffer; evicted: Buffer };
}

//#endregion

//#region Registry (DP-E §6.3)

const registry = new Map<string, Strategy>();

/** Register (or replace) a strategy by its `name`. Extension point — no chassis code edit. */
export function registerStrategy(s: Strategy): void {
  registry.set(s.name, s);
}

/** Resolve a strategy by name; null when unknown (core layer warns + falls back per GOV-RES-02). */
export function getStrategy(name: string): Strategy | null {
  return registry.get(name) ?? null;
}

//#endregion
