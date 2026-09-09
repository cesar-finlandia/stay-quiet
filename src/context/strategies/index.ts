// Requirement IDs: CTX-04, CTX-RES-02
// Strategy module entry (DP-E §6.3): re-exports the registry API and registers both
// built-in strategies. Chassis ships exactly these two mechanical strategies; additional
// strategies are extension-registered via registerStrategy() — never a chassis code edit.
// Import this module once for its registration side effect (it is also re-exported by
// src/context/index.ts).
import { keepLastNStrategy } from "./keep_last_n.js";
import { slidingWindowPinnedStrategy } from "./sliding_window_pinned.js";
import {
  getStrategy,
  registerStrategy,
  type Strategy,
} from "./types.js";

export { getStrategy, registerStrategy };
export type { Strategy, StrategyContext } from "./types.js";
export { KEEP_LAST_N_DEFAULT, keepLastN } from "./keep_last_n.js";
export { slidingWindowPinned } from "./sliding_window_pinned.js";

let registered = false;

/** Idempotently register both built-in strategies under their plan §6 names. */
export function ensureBuiltInStrategiesRegistered(): void {
  if (registered) return;
  registerStrategy(slidingWindowPinnedStrategy); // "sliding-window-pinned"
  registerStrategy(keepLastNStrategy); // "keep-last-n"
  registered = true;
}

ensureBuiltInStrategiesRegistered();
