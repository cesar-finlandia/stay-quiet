// Requirement IDs: CTX-04, CTX-RES-02
// Secondary mechanical truncation strategy (DP-E §6.2): keep pinned messages plus the last
// N evictable messages by position (strategy_options.n, default 4). If that candidate still
// overflows the remaining budget, degrade to the same token-driven backwards loop as §6.1 so
// the budget is never violated (CTX-AC-01). Position/token driven only — content-oblivious.
// Deterministic and side-effect-free by default (CTX-RES-02).
import type { Buffer, Message } from "../types.js";
import { resolveInputBudget, type Strategy, type StrategyContext } from "./types.js";

function isPinned(m: Message): boolean {
  return m.metadata?.pinned === true;
}

/** Default N per DP-E §6.2 (`n` defaults to 4 when strategy_options.n absent/invalid). */
export const KEEP_LAST_N_DEFAULT = 4;

function resolveN(ctx: StrategyContext): number {
  const raw = ctx.config.strategy_options?.["n"];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : KEEP_LAST_N_DEFAULT;
}

export function keepLastN(
  buffer: Buffer,
  ctx: StrategyContext,
): { buffer: Buffer; evicted: Buffer } {
  const { countMessage } = ctx;
  const budget = resolveInputBudget(ctx.config);

  // Fast path — nothing to evict.
  if (ctx.countBuffer(buffer) <= budget) {
    return { buffer: [...buffer], evicted: [] };
  }

  // Partition pinned vs evictable preserving stable original order (§6.1 partition).
  const originalIndex = new Map<Message, number>();
  buffer.forEach((m, i) => originalIndex.set(m, i));
  const pinned = buffer.filter(isPinned);
  const evictable = buffer.filter((m) => !isPinned(m));

  let pinnedTokens = 0;
  for (const m of pinned) pinnedTokens += countMessage(m);

  // Pinned set alone exceeds budget — same handback as §6.1/§8 row 4; outer fit() layer
  // overrides the status to rejected:"pinned_exceeds_budget". Never throw here.
  if (pinnedTokens > budget) {
    return { buffer: [...pinned], evicted: [...evictable] };
  }

  const remainingBudget = budget - pinnedTokens;
  const n = resolveN(ctx);

  // Candidate = last N evictable by position (not by tokens), per §6.2.
  let kept: Message[];
  if (n === 0) {
    kept = [];
  } else {
    const candidate = evictable.slice(-n);
    // Sum the candidate's tokens newest → oldest so we can degrade deterministically.
    const candidateTokens: number[] = [];
    let candidateTotal = 0;
    for (let i = candidate.length - 1; i >= 0; i--) {
      const tok = countMessage(candidate[i] as Message);
      candidateTokens.unshift(tok);
      candidateTotal += tok;
    }
    if (candidateTotal <= remainingBudget) {
      kept = [...candidate];
    } else {
      // Degrade to the §6.1 token-driven backwards loop over the candidate so the budget
      // is never violated even when N is large (CTX-AC-01). Contiguous suffix only.
      kept = [];
      let acc = 0;
      for (let i = candidate.length - 1; i >= 0; i--) {
        const tok = candidateTokens[i] as number;
        if (acc + tok <= remainingBudget) {
          kept.unshift(candidate[i] as Message);
          acc += tok;
        } else {
          break;
        }
      }
    }
  }
  const keptSet = new Set(kept);

  // Evicted diagnostics: everything not kept (pinned entries are never evicted).
  const evicted = buffer.filter((m) => !isPinned(m) && !keptSet.has(m));

  // Reassemble [pinned..., kept...] restored to original buffer order via stable sort.
  const result = [...pinned, ...kept];
  result.sort(
    (a, b) => (originalIndex.get(a) as number) - (originalIndex.get(b) as number),
  );
  return { buffer: result, evicted };
}

export const keepLastNStrategy: Strategy = {
  name: "keep-last-n",
  fit: keepLastN,
};
