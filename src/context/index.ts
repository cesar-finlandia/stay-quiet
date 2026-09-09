// Requirement IDs: CTX-REU-01, CTX-01..CTX-06, XCUT-06
// Public entry of the Context & Conversation Buffer Manager (DP-E §9.1).
// Consumers import ONLY from here — never internals like strategies/sliding_window_pinned
// or token_counter internals (forbidden by §9.1, CI-enforced). Importing this module has
// the side effect of registering the two built-in truncation strategies (§6.3).
// Zero dependency on other chassis components: only stdlib + contracts/*.json via
// ./token_counter.js — no src/resilience|platform|media|assembly|cost imports (CTX-REU-01).
import "./strategies/index.js"; // registration side effect (sliding-window-pinned, keep-last-n)
import "./adapters/index.js"; // registration side effect (openai-chat, anthropic-messages, generic)

// Core pipeline (fit/append) + peek status / budget arithmetic (CTX-03, CTX-06).
export { fit, append } from "./core.js";
export { calcStatus, calcBudget } from "./budget.js";

// Single source of truth for token counting (CTX-02); also consumed by COST (COST-REU-02).
export { count, countMessage, countBuffer, budget } from "./token_counter.js";

// Extension points: register additional mechanical strategies (§6.3), provider
// adapters (§3.3), and the engine's CTX-05 compaction function (§7) without chassis edits.
export { registerStrategy } from "./strategies/index.js";
export { registerAdapter, getAdapter, listAdapters } from "./adapters/index.js";
export type { ProviderAdapter } from "./adapters/index.js";
export {
  registerCompaction,
  getCompaction,
  fitWithCompaction,
} from "./extension.js";
export type { CompactionFn, CompactionConfig } from "./extension.js";

// Optional async path with CTX-05 compaction (DP-E §7.2, §9.1):
// import { fitWithCompaction } from "src/context/extension" — also re-exported here.

// Public domain types (DP-E §3.1–§3.4). Internal-only shapes stay unexported.
export type {
  Message,
  MessageMetadata,
  Buffer,
  BufferStatus,
  FitResult,
  ContextBudgetConfig,
  TruncationStrategy,
} from "./types.js";
