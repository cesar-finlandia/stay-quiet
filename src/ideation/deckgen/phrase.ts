// Requirement IDs: DECKGEN-RES-01, RES-01, RES-06, RES-07, PGM-11, GOV-REU-02
// RES-01-wrapped LLM bullet phrasing for DECKGEN — DP-D2a §6.1/§6.2/§7.
//
// - resilientDeckPhrase wraps the injected transport in withResilience with the
//   §6.1 defaults: timeout_ms 20000, retries 1, exponential backoff base 500ms
//   factor 2 max 4000ms jitter, fallback_chain ["none"] (manual checklist, not
//   a cache — ADV-05 analogue).
// - phraseBullets(slotId, planExcerpt) NEVER throws and never rethrows: every
//   failure (missing transport, unresolved role, timeout, retry exhaustion,
//   unparseable output) maps to DegradedResult{reason:"deck_llm_failed",
//   fallback_source:"none", data:planExcerpt} which populate.ts renders as the
//   §3.2 literal TODO + raw-excerpt blockquote — deck is never blank.
// - Model routing: getModelForRole("deckgen_phraser") reads THE shared
//   config/model-profiles.json (PGM-11 single file); no model id is hardcoded
//   in src/ideation/deckgen (GOV-REU-02). Unresolvable role → degraded, warn.
// - The repo has no SDK adapter (mirrors src/pgm/resilientCall.ts): the actual
//   provider callable is injected by the caller; omitting it yields a
//   DegradedResult. RES_FORCED_DEGRADED=1 forces degradation inside the
//   wrapper (RES-07 kill switch) even when a transport is supplied.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDegradedResult, makeDegradedResult, withResilience } from "../../resilience/index.js";
import type { DegradedResult } from "../../resilience/index.js";

const DECKGEN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DECKGEN_DIR, "..", "..", "..");
export const PHRASE_PROMPT_PATH = join(DECKGEN_DIR, "templates", "deck-phrase.prompt.md");
export const MODEL_PROFILES_PATH = join(REPO_ROOT, "config", "model-profiles.json");

/** §6.1 wrapper defaults for DECKGEN phrasing. */
export const DECKGEN_PHRASE_CONFIG = {
  timeout_ms: 20000,
  retries: 1,
  backoff: { policy: "exponential" as const, base_ms: 500, factor: 2, max_ms: 4000, jitter: true },
  fallback_chain: { order: ["none" as const] },
} satisfies import("../../resilience/index.js").ResilienceConfig;

/** Shared-file role key (§7): deckgen_phraser → analyst-balanced profile. */
export const DECKGEN_PHRASER_ROLE = "deckgen_phraser";

/** Minimal transport contract: prompt in, completion text out (tests mock it). */
export type DeckLlmTransport = (prompt: string) => string | Promise<string>;

/** Resolved role routing from the shared file (never a hardcoded model id). */
export interface RoleModelRouting {
  provider: string;
  model: string;
}

let warnedModelFallback = false;

/**
 * getModelForRole(role) — role→profile lookup in THE shared
 * config/model-profiles.json (PGM-11; aliased as model_profiles wrapper or
 * roles.role map tolerated defensively, mirroring the advisor reader).
 * Absent/malformed → warn ONCE + null routing (caller degrades); NEVER throws
 * (GOV-RES-02). No default model id is hardcoded here (GOV-REU-02).
 */
export function getModelForRole(role: string): RoleModelRouting | null {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_PROFILES_PATH, "utf8")) as Record<string, unknown>;
    const candidates: unknown[] = [
      parsed[role],
      (parsed["roles"] as Record<string, unknown> | undefined)?.[role],
      (parsed["model_profiles"] as Record<string, unknown> | undefined)?.[role],
    ];
    let profileName: string | null = null;
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        profileName = c.trim();
        break;
      }
      if (c && typeof c === "object") {
        const mp = (c as Record<string, unknown>)["model_profile"];
        if (typeof mp === "string" && mp.trim()) {
          profileName = mp.trim();
          break;
        }
      }
    }
    if (!profileName) return null;
    const profiles = (parsed["profiles"] ?? parsed["model_profiles"]) as Record<string, unknown> | undefined;
    const raw = profiles?.[profileName];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const provider = typeof obj["provider"] === "string" ? obj["provider"].trim() : "";
      const model = typeof obj["model"] === "string" ? obj["model"].trim() : "";
      if (provider && model) return { provider, model };
    }
    return null;
  } catch (err) {
    if (!warnedModelFallback) {
      warnedModelFallback = true;
      console.warn(
        `warn: config/model-profiles.json unreadable (${err instanceof Error ? err.message : String(err)}) — role ${role} unresolved; LLM phrasing degrades to TODO fallback`,
      );
    }
    return null;
  }
}

//#region Prompt rendering + output parsing

let cachedPromptTemplate: string | null = null;

/** Generic prompt template (GOV-REU-02): only {{planExcerpt}} is injected. */
function loadPromptTemplate(): string {
  if (cachedPromptTemplate === null) cachedPromptTemplate = readFileSync(PHRASE_PROMPT_PATH, "utf8");
  return cachedPromptTemplate;
}

/** Render one slot's prompt; excerpt is fenced off so it cannot leak out. */
export function renderPhrasePrompt(planExcerpt: string): string {
  return loadPromptTemplate().replace("{{planExcerpt}}", planExcerpt.trim());
}

/** Strip an optional markdown fence around the JSON completion. */
function fencedStrip(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
}

/** Parse + shape-check {bullets:string[]} — throws on any deviation. */
export function parsePhraseResponse(raw: string): { bullets: string[] } {
  const parsed: unknown = JSON.parse(fencedStrip(raw));
  const bullets =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { bullets?: unknown }).bullets)
      ? ((parsed as { bullets: unknown[] }).bullets.filter(
          (b) => typeof b === "string" && b.trim() !== "",
        ) as string[])
      : null;
  if (!bullets || bullets.length === 0) throw new Error("phrasing output missing non-empty bullets[] array");
  return { bullets };
}

//#endregion

//#region RES-01-wrapped phrasing (§6.2)

/**
 * resilientDeckPhrase — withResilience wrapper around one transport call using
 * the §6.1 defaults. Exported for direct reuse/tests; phraseBullets is the
 * never-throw entry point populate.ts consumes.
 */
export function makeResilientDeckPhrase(transport: DeckLlmTransport, prompt: string) {
  return withResilience(() => transport(prompt), DECKGEN_PHRASE_CONFIG);
}

export interface PhraseSuccess {
  bullets: string[];
  excerpt: string;
}

export type PhraseOutcome = PhraseSuccess | DegradedResult;

export interface PhraseOptions {
  /** Provider/SDK callable; tests inject mocks. Omit → degraded (no transport). */
  transport?: DeckLlmTransport;
}

/**
 * phraseBullets(slotId, planExcerpt) — §6.2. One RES-01-wrapped call per slot;
 * EVERY failure path returns a DegradedResult (reason "deck_llm_failed",
 * fallback_source "none", data = raw excerpt) — never throws, never rethrows.
 * The caller renders the §3.2 TODO literal + excerpt blockquote from it.
 */
export async function phraseBullets(
  slotId: string,
  planExcerpt: string,
  opts: PhraseOptions = {},
): Promise<PhraseOutcome> {
  const excerpt = planExcerpt ?? "";
  try {
    const routing = getModelForRole(DECKGEN_PHRASER_ROLE);
    if (!routing) throw new Error(`model role ${DECKGEN_PHRASER_ROLE} unresolved in config/model-profiles.json`);
    if (!opts.transport) throw new Error("no LLM transport available for deckgen_phraser (offline or unconfigured)");
    const prompt = renderPhrasePrompt(excerpt);
    const wrapped = makeResilientDeckPhrase(opts.transport, prompt);
    const out = await wrapped();
    if (isDegradedResult(out)) {
      // Timeout/retry exhaustion or forced degradation (RES_FORCED_DEGRADED=1):
      // normalize reason so callers can grep one literal (§6.2 slot map).
      return makeDegradedResult({
        reason: "deck_llm_failed",
        fallback_source: "none",
        original_error: out.original_error ?? out.reason,
        data: excerpt,
      });
    }
    const parsed = parsePhraseResponse(String(out));
    return { bullets: parsed.bullets, excerpt };
  } catch (e) {
    return makeDegradedResult({
      reason: "deck_llm_failed",
      fallback_source: "none",
      original_error: e instanceof Error ? e.message : String(e),
      data: excerpt,
    });
  }
}

//#endregion

//#region Slot-phraser factory consumed by populate.ts / cli.ts

/**
 * Async slot phraser signature populate.ts accepts as its optional `phraser`:
 * given a slot id ("01".."08") and the raw plan excerpt for that slot, returns
 * phrased bullets or a DegradedResult (never throws).
 */
export type SlotPhraser = (slotId: string, planExcerpt: string) => Promise<PhraseOutcome>;

/** Build the default deckgen_phraser-backed SlotPhraser. */
export function makeDeckgenPhraser(opts: PhraseOptions = {}): SlotPhraser {
  return (slotId: string, planExcerpt: string) => phraseBullets(slotId, planExcerpt, opts);
}

//#endregion
