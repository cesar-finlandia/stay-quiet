// Requirement IDs: CTX-03, CTX-06, CTX-AC-03, CTX-RES-01, CTX-RES-02, GOV-RES-02, GOV-RES-04
// Core fit/append pipeline (DP-E §5.1 "when computed", §8 edge cases).
// append(buffer, msg, config) === fit([...buffer, msg], config) (§8.1).
// Every public function is wrapped in an outer try/catch — never throws unhandled
// (GOV-RES-04); failures degrade to a typed FitResult with safe defaults (GOV-RES-02).
// Deterministic: no timestamps/randomness in output; default path never mutates the
// input buffer or its Message objects (CTX-RES-02); mutate:true opts into reuse.
// Zero imports from other chassis components (CTX-REU-01).
import {
  calcBudget,
  classifyWarning,
  CONTEXT_DEFAULTS,
  resolveConfig,
} from "./budget.js";
import { countBuffer, countMessage } from './token_counter.js';
import { getStrategy } from "./strategies/index.js"; // import also registers built-in strategies (§6.3)
import type { Strategy, StrategyContext } from "./strategies/types.js";
import type { Buffer, BufferStatus, ContextBudgetConfig, FitResult, Message } from "./types.js";

//#region Local message validation (contracts/message.schema.json shape; plan §8.2)

const VALID_ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

type ValidationFailure = { valid: false; reason: string };

/**
 * Structural check against the Message contract — self-contained (no cross-chassis
 * import of RES-04 per CTX-REU-01). Returns null when valid, else a stable reason.
 */
function validateMessage(entry: unknown): ValidationFailure | null {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    return { valid: false, reason: "entry_not_object" };
  }
  const m = entry as Record<string, unknown>;
  if (!VALID_ROLES.includes(m["role"] as string)) {
    return { valid: false, reason: `invalid role ${JSON.stringify(m["role"])}` };
  }
  if (typeof m["content"] !== "string") {
    return { valid: false, reason: "content_not_string" };
  }
  const md = m["metadata"];
  if (md !== undefined && (md === null || typeof md !== "object" || Array.isArray(md))) {
    return { valid: false, reason: "metadata_not_object" };
  }
  if (md != null) {
    const prio = (md as Record<string, unknown>)["priority"];
    if (
      prio !== undefined &&
      (typeof prio !== "number" || !Number.isInteger(prio) || prio < 0 || prio > 100)
    ) {
      return { valid: false, reason: "priority_out_of_range" };
    }
  }
  const tc = m["token_count"];
  if (
    tc !== undefined &&
    tc !== null &&
    (typeof tc !== "number" || !Number.isFinite(tc) || tc < 0)
  ) {
    return { valid: false, reason: "token_count_invalid" };
  }
  return null;
}

//#endregion

//#region Diagnostics channel (bounded, non-throwing; GOV-RES-02 style)

function warn(message: string): void {
  console.warn(`[context] ${message}`);
}

//#endregion

//#region Status construction helpers

/**
 * Full status for a concrete result buffer — always emitted, even without truncation
 * (§5.2). Warning is classified POST-fit (§8.3 table row 3: "none" post-fit).
 */
function makeStatus(
  buffer: Buffer,
  effective: ContextBudgetConfig,
  appliedStrategy: string,
  inputBudget: number,
  opts: { truncated: boolean; evictedCount: number },
): BufferStatus {
  const totalTokens = countBuffer(buffer, effective.model_profile);
  const utilization = inputBudget > 0 ? totalTokens / inputBudget : totalTokens > 0 ? Infinity : 0;
  return {
    total_tokens: totalTokens,
    input_budget: inputBudget,
    utilization,
    truncated: opts.truncated,
    evicted_count: opts.evictedCount,
    warning: classifyWarning(totalTokens, utilization, { ...effective, input_budget: inputBudget }),
    rejected: false,
    strategy: appliedStrategy,
    model_profile: effective.model_profile,
  };
}

/** §8.3 CTX-AC-03 rejection envelope: typed status, never an unhandled throw. */
function makeRejectedResult(
  outBuffer: Buffer,
  effective: ContextBudgetConfig,
  appliedStrategy: string,
  inputBudget: number,
  evictedCount: number,
  reason: string,
): FitResult {
  const base = makeStatus(outBuffer, effective, appliedStrategy, inputBudget, {
    truncated: false, // rejections never truncate (§8.3 table rows 1–2)
    evictedCount,
  });
  // rejectedStatus overrides per CTX-AC-03: rejected:true, warning:"exceeded", reason set.
  const status: BufferStatus = { ...base, rejected: true, reason, warning: "exceeded", truncated: false };
  return { buffer: outBuffer, status };
}

//#endregion

//#region Internal pipeline steps (§8 edge-case order)

/** GOV-RES-02 strategy resolution: unknown/non-enum name → warn + default (§6.3). */
function resolveStrategy(name: string): { strategy: Strategy | null; appliedName: string } {
  const direct = getStrategy(name);
  if (direct) return { strategy: direct, appliedName: direct.name };
  const fallbackName = CONTEXT_DEFAULTS.strategy;
  if (name !== fallbackName) {
    warn(`unknown strategy "${name}", falling back to "${fallbackName}"`);
  }
  const fallback = getStrategy(fallbackName);
  return { strategy: fallback, appliedName: fallback ? fallback.name : String(fallbackName) };
}

/** §8.4 mutate opt-in: in-place `buffer.length = 0; push(...result)` to avoid allocation. */
function replaceInPlace(target: Buffer, next: Buffer): Buffer {
  target.length = 0;
  for (const m of next) target.push(m);
  return target;
}

/** Shallow copy preserving element identity — default path stays copy-on-write (CTX-RES-02). */
function copyOf(buffer: Buffer): Buffer {
  return [...buffer];
}

//#endregion

//#region Public API

/**
 * Fit a buffer to the input budget (DP-E §5.1 lazily, §6 strategy, §8 edges).
 * Pipeline: resolve config → validate entries (§8.2 filter-with-warn) → CTX-AC-03
 * pre-checks (§8.3) → strategy → status. Default path never mutates the input
 * buffer nor its Message objects (CTX-RES-02); mutate:true reuses the caller array.
 * Never throws unhandled (GOV-RES-04) — degrades to a typed FitResult (GOV-RES-02).
 */
export function fit(buffer: Buffer, config?: Partial<ContextBudgetConfig> | null): FitResult {
  try {
    let input: Buffer = buffer;
    if (!Array.isArray(input)) {
      warn("fit(): buffer is not an array; treating as empty");
      input = [];
    }
    const effective = resolveConfig(config);
    const inputBudget = calcBudget(effective).input_budget;

    // §8.1 empty-buffer no-op (CTX-RES-01): real budget reported, warning none.
    if (input.length === 0) {
      const { appliedName } = resolveStrategy(effective.strategy ?? CONTEXT_DEFAULTS.strategy);
      return {
        buffer: [],
        status: makeStatus([], effective, appliedName, inputBudget, {
          truncated: false,
          evictedCount: 0,
        }),
      };
    }

    // §8.2 per-entry validation loop — malformed entries treated as evicted + warned,
    // never throwing; remaining buffer still fitted (CTX-RES-01).
    const clean: Buffer = [];
    let invalidCount = 0;
    for (let i = 0; i < input.length; i++) {
      const entry = input[i] as Message;
      try {
        const failure = validateMessage(entry);
        if (failure) {
          warn(`context message invalid at index ${i} — ${failure.reason}`);
          invalidCount++;
          continue;
        }
        clean.push(entry);
      } catch (e) {
        warn(`context message invalid at index ${i} — ${e instanceof Error ? e.message : String(e)}`);
        invalidCount++;
      }
    }

    const { strategy, appliedName } = resolveStrategy(effective.strategy ?? CONTEXT_DEFAULTS.strategy);

    // Everything malformed → nothing left to fit (still a full, typed status).
    if (clean.length === 0) {
      return {
        buffer: [],
        status: makeStatus([], effective, appliedName, inputBudget, {
          truncated: invalidCount > 0,
          evictedCount: invalidCount,
        }),
      };
    }

    // §8.3 / edge-table row 4: pinned set alone exceeds budget → pinned-only result,
    // explicit rejection; caller must shorten the pinned system prompt (no auto-drop).
    let pinnedTokens = 0;
    for (const m of clean) {
      if (m.metadata?.pinned === true) pinnedTokens += countMessage(m, effective.model_profile);
    }
    if (pinnedTokens > inputBudget) {
      warn("pinned messages exceed input budget; rejecting without auto-drop (shorten the pinned system prompt)");
      const pinnedOnly = clean.filter((m) => m.metadata?.pinned === true);
      const out = effective.mutate ? replaceInPlace(input, pinnedOnly) : copyOf(pinnedOnly);
      return makeRejectedResult(
        out,
        effective,
        appliedName,
        inputBudget,
        invalidCount,
        "pinned_exceeds_budget",
      );
    }

    // §8.3 CTX-AC-03: single oversized message — latest alone over budget (or pinned+
    // latest jointly, per edge-table detection `pinnedTokens + count(latest) > budget`).
    // Return the clean buffer AS-IS with rejected:true — eviction cannot help, and the
    // chassis never truncates a message's content mid-string.
    const latest = clean[clean.length - 1] as Message;
    const latestTokens = countMessage(latest, effective.model_profile);
    if (latestTokens > inputBudget || pinnedTokens + latestTokens > inputBudget) {
      warn(`single_message_exceeds_budget (${latestTokens} > ${inputBudget}); rejecting unchanged buffer`);
      const out = effective.mutate ? replaceInPlace(input, clean) : copyOf(clean);
      return makeRejectedResult(
        out,
        effective,
        appliedName,
        inputBudget,
        invalidCount,
        "single_message_exceeds_budget",
      );
    }

    // Normal path: mechanical truncation via the resolved strategy (§6). Strategies are
    // deterministic and always allocation-fresh, so core owns the mutate semantics.
    if (!strategy) {
      // Unreachable while strategies/index.ts is imported (registers both built-ins),
      // but stay typed: degrade without throwing (GOV-RES-04).
      warn("no truncation strategy registered; returning buffer unfitted");
      const out = effective.mutate ? replaceInPlace(input, clean) : copyOf(clean);
      return {
        buffer: out,
        status: makeStatus(out, effective, appliedName, inputBudget, {
          truncated: invalidCount > 0,
          evictedCount: invalidCount,
        }),
      };
    }
    const ctx: StrategyContext = {
      config: effective,
      countBuffer: (buf) => countBuffer(buf, effective.model_profile),
      countMessage: (m) => countMessage(m, effective.model_profile),
    };
    const res = strategy.fit(clean, ctx); // { buffer, evicted }, never throws (§6 preamble)
    const evictedCount = invalidCount + res.evicted.length;
    const fitted = effective.mutate ? replaceInPlace(input, res.buffer) : res.buffer;
    return {
      buffer: fitted,
      status: makeStatus(fitted, effective, appliedName, inputBudget, {
        truncated: evictedCount > 0,
        evictedCount,
      }),
    };
  } catch (e) {
    // GOV-RES-04 absolute last resort: never throw unhandled; degrade to safe defaults.
    warn(`fit() degraded to safe defaults: ${e instanceof Error ? e.message : String(e)}`);
    return {
      buffer: [],
      status: {
        total_tokens: 0,
        input_budget: 0,
        utilization: 0,
        truncated: false,
        evicted_count: 0,
        warning: "none",
        rejected: false,
        reason: "internal_error",
        strategy: CONTEXT_DEFAULTS.strategy,
        model_profile: CONTEXT_DEFAULTS.model_profile,
      },
    };
  }
}

/**
 * Append one message then fit — exactly `fit([...buffer, message], config)` (DP-E §8.1).
 * The input buffer is never mutated when config.mutate is false (default).
 */
export function append(
  buffer: Buffer,
  message: Message,
  config?: Partial<ContextBudgetConfig> | null,
): FitResult {
  const base: Buffer = Array.isArray(buffer) ? [...buffer] : [];
  base.push(message);
  return fit(base, config);
}

//#endregion
