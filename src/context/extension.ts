// Requirement IDs: CTX-05, NONGOAL-07, GOV-RES-04, XCUT-08
// CTX-05 extension slot ONLY (DP-E §7): a typed CompactionFn slot plus an async
// orchestrator fitWithCompaction(). This module ships ZERO LLM prompt text and
// and makes ZERO LLM/provider calls — Engine registers its own compaction function
// at runtime; chassis never imports it (NONGOAL-07).
//
// Determinism invariant: synchronous fit() is NEVER changed and NEVER calls a
// CompactionFn (CTX-RES-02). fitWithCompaction() awaits the registered fn per the
// `when` rule, then re-validates through synchronous fit() so the budget guarantee
// stays mechanical.
import { fit } from "./core.js";
import type {
  Buffer,
  ContextBudgetConfig,
  FitResult,
} from "./types.js";

//#region Types (§7.1)

/** Engine-supplied compaction function. May be sync or async after an LLM call
 *  made OUTSIDE chassis. Input: current buffer + budget config. Output: compacted
 *  buffer that SHOULD fit input_budget (not enforced — caller re-validates via fit()). */
export type CompactionFn = (
  buffer: Buffer,
  config: ContextBudgetConfig
) => Buffer | Promise<Buffer>;

export type CompactionConfig = {
  /** Registered compaction function. If absent, CTX-05 is disabled (chassis default). */
  fn?: CompactionFn;
  /** When to attempt compaction vs the mechanical strategy. Default "after". */
  when?: "before" | "after" | "instead";
  /** Optional label for status reporting, e.g. "engine-llm-condenser". */
  label?: string;
};

//#endregion

//#region Registration

let compaction: CompactionConfig | null = null;

/** Register the engine's compaction function. Passing null disables the slot. */
export function registerCompaction(
  fn: CompactionFn | null,
  opts?: { when?: CompactionConfig["when"]; label?: string }
): void {
  compaction = fn ? { fn, when: opts?.when ?? "after", label: opts?.label } : null;
}

/** Current registration or null (CTX-05 disabled by default). */
export function getCompaction(): CompactionConfig | null {
  return compaction;
}

//#endregion

//#region fitWithCompaction pipeline (§7.2)

/**
 * Async compaction orchestrator (§7.2). Synchronous fit() is never altered; this
 * entry awaits the registered CompactionFn per the `when` rule, then re-validates
 * via synchronous fit() so the budget guarantee is mechanical, not trusting.
 *
 * Failure policy (GOV-RES-04): if the fn throws/rejects or returns an over-budget
 * buffer, fall back to the mechanical fit() result and annotate status.reason —
 * NEVER throw. Without a registered fn it behaves identically to fit().
 */
export async function fitWithCompaction(
  buffer: Buffer,
  config?: Partial<ContextBudgetConfig> | null
): Promise<FitResult> {
  const reg = compaction;
  const when = reg?.when ?? "after";
  // No fn registered → identical to sync fit() (§7.2).
  if (!reg || !reg.fn) return fit(buffer, config);

  const runMechanical = (): FitResult => fit(buffer, config);

  /** Attempt compaction; returns null on throw/reject/non-array output (GOV-RES-04). */
  const tryCompact = async (): Promise<Buffer | null> => {
    try {
      const out = await reg.fn!(buffer, config as ContextBudgetConfig);
      return Array.isArray(out) ? out : null;
    } catch {
      return null;
    }
  };

  const annotate = (r: FitResult, why: string): FitResult => ({
    ...r,
    status: { ...r.status, reason: r.status.reason ?? why },
  });

  // "before"/"instead": compact first. "after": mechanical first.
  let compacted: Buffer | null = null;
  if (when === "before" || when === "instead") {
    compacted = await tryCompact();
  }

  if (compacted) {
    // Re-validate via SYNCHRONOUS fit(): budget guarantee stays mechanical.
    const validated = fit(compacted, config);
    if (!validated.status.rejected) return validated;
    // Compacted output itself cannot fit (e.g. one oversize message) → fall back.
    return annotate(runMechanical(), `compaction (${reg.label ?? "unlabeled"}) output rejected; mechanical fallback applied`);
  }

  if (when !== "after") {
    // "before"/"instead" with failed compaction → mechanical result + reason.
    return annotate(
      runMechanical(),
      when === "instead"
        ? `compaction (${reg.label ?? "unlabeled"}) failed/unavailable; mechanical strategy applied as safety net`
        : `compaction (${reg.label ?? "unlabeled"}) failed; mechanical strategy used`
    );
  }

  // "after": mechanical first; invoke compaction when the pass was LOSSY
  // (evictions happened) or still hot (approaching/exceeded) — §7.2 "still approaching".
  const mechanical = runMechanical();
  if (!mechanical.status.truncated && mechanical.status.warning === "none") return mechanical;

  compacted = await tryCompact();
  if (!compacted) {
    return annotate(mechanical, `compaction (${reg.label ?? "unlabeled"}) failed after mechanical pass; mechanical result kept`);
  }
  const validated = fit(compacted, config);
  const fits = !validated.status.rejected && validated.status.total_tokens <= validated.status.input_budget;
  // Accept only if compaction did strictly better than the mechanical safety net:
  // fits AND either a better warning level or preserved strictly more entries.
  const better =
    fits &&
    (severity(validated.status) < severity(mechanical.status) ||
      validated.status.evicted_count < mechanical.status.evicted_count);
  if (better) return validated;
  // No improvement (or rejected) → keep the deterministic mechanical result.
  return annotate(mechanical, `compaction (${reg.label ?? "unlabeled"}) produced no improvement; mechanical result kept`);
}

/** Ordering helper: none < approaching < exceeded. */
function severity(s: { warning: "none" | "approaching" | "exceeded" }): number {
  return s.warning === "none" ? 0 : s.warning === "approaching" ? 1 : 2;
}

//#endregion
