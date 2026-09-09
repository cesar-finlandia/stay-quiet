// Requirement IDs: CTX-04, CTX-RES-02
// Primary mechanical truncation strategy (DP-E §6.1): always retain pinned messages plus
// the contiguous suffix of newest evictable messages that fits the remaining budget.
// Content-oblivious: reads only metadata.pinned and token counts from ctx.countMessage.
// Deterministic and side-effect-free by default (CTX-RES-02): no Math.random/timestamps,
// input buffer and its Message objects are never mutated when config.mutate is false.
import type { Buffer, Message } from "../types.js";
import { resolveInputBudget, type Strategy, type StrategyContext } from "./types.js";

function isPinned(m: Message): boolean {
  return m.metadata?.pinned === true;
}

export function slidingWindowPinned(
  buffer: Buffer,
  ctx: StrategyContext,
): { buffer: Buffer; evicted: Buffer } {
  const { countMessage } = ctx;
  // DP-E §6.1: budget comes from the resolved effective config (§5.1 arithmetic).
  const budget = resolveInputBudget(ctx.config);

  // Fast path — nothing to evict.
  if (ctx.countBuffer(buffer) <= budget) {
    return { buffer: [...buffer], evicted: [] };
  }

  // Partition pinned vs evictable preserving stable original order (§6.1).
  const originalIndex = new Map<Message, number>();
  buffer.forEach((m, i) => originalIndex.set(m, i));
  const pinned = buffer.filter(isPinned);
  const evictable = buffer.filter((m) => !isPinned(m));

  let pinnedTokens = 0;
  for (const m of pinned) pinnedTokens += countMessage(m);

  // Pinned set alone exceeds budget — never silently drop pinned (§8 row 4):
  // hand back { pinned, all-evictable } and let the outer fit() layer override the
  // status to rejected:"pinned_exceeds_budget". The strategy itself never throws.
  if (pinnedTokens > budget) {
    return { buffer: [...pinned], evicted: [...evictable] };
  }

  // Keep a contiguous suffix of newest evictable messages that fits remainingBudget:
  // walk newest → oldest and break on first overflow (contiguous window, not a subset).
  const remainingBudget = budget - pinnedTokens;
  const keptSet = new Set<Message>();
  let acc = 0;
  for (let i = evictable.length - 1; i >= 0; i--) {
    const m = evictable[i] as Message;
    const tok = countMessage(m);
    if (acc + tok <= remainingBudget) {
      keptSet.add(m);
      acc += tok;
    } else {
      break; // sliding-window semantics: keep contiguous suffix from most recent
    }
  }

  // Evicted diagnostics: everything not kept (pinned entries are never evicted).
  const evicted = buffer.filter((m) => !isPinned(m) && !keptSet.has(m));

  // Reassemble [pinned..., kept suffix...] restored to original buffer order via a
  // stable sort by original index (pinned may be interleaved in the input).
  const result = [...pinned, ...keptSet];
  result.sort(
    (a, b) => (originalIndex.get(a) as number) - (originalIndex.get(b) as number),
  );
  return { buffer: result, evicted };
}

export const slidingWindowPinnedStrategy: Strategy = {
  name: "sliding-window-pinned",
  fit: slidingWindowPinned,
};
