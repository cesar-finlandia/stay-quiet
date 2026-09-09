// Requirement IDs: CTX-02, COST-REU-02, GOV-REU-02, GOV-RES-04
// Chassis-wide single source of truth for token counting (DP-E §4; master_blueprint.md §4 contract #5).
//
// Scheme-dependent constants (the ONLY ones — DP-E §5.1):
//   - "heuristic":           Math.ceil(chars / 4) + 4 framing tokens per message
//   - "anthropic-heuristic": Math.ceil(chars / 4) + 5 framing tokens per message
//
// All counting is synchronous, pure and deterministic: no network, no LLM call (GOV-RES-04).
// COST (COST-REU-02) imports from here and never reimplements tokenizer logic.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Message } from "./types.js";

//#region Contracts map (DP-E §4.2)

type ProfileEntry = { tokenizer: string; context_window: number; notes?: string };
type TokenizerProfilesFile = {
  profiles?: Record<string, ProfileEntry>;
  default_profile?: string;
};

const PROFILES_FILENAME = "tokenizer-profiles.json";
const GENERIC_PROFILE = "generic-heuristic";
const GENERIC_CONTEXT_WINDOW = 8192; // §11: context_window missing & profile unknown → 8192

/**
 * Locate the repo-root contracts/ dir by walking up from this module (bounded).
 * Works both in-tree (src/context/) and in emitted test layouts (.tmp_emit/src/context/)
 * without a build step or dependency (CTX-REU-01: stdlib only).
 */
function findContractsUrl(filename: string): URL | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      const candidate = join(dir, "contracts", filename);
      if (existsSync(candidate)) return pathToFileURL(candidate);
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  } catch {
    // fall through to null — caller warns and uses safe defaults
  }
  return null;
}

function loadProfiles(): TokenizerProfilesFile {
  try {
    const url = findContractsUrl(PROFILES_FILENAME);
    if (!url) throw new Error("contracts/tokenizer-profiles.json not found from module dir");
    const raw = readFileSync(url, "utf8");
    return JSON.parse(raw) as TokenizerProfilesFile;
  } catch (e) {
    warn(`tokenizer-profiles.json unreadable (${e instanceof Error ? e.message : String(e)}), using empty profile map`);
    return {};
  }
}

const profilesFile: TokenizerProfilesFile = loadProfiles();

/** Resolve a model_profile → { tokenizer scheme name, context_window }. Unknown → warn + generic-heuristic (§8). */
function resolveProfile(modelProfile: string): ProfileEntry {
  const hit = profilesFile.profiles?.[modelProfile];
  if (hit && typeof hit.tokenizer === "string" && typeof hit.context_window === "number") {
    return hit;
  }
  const fallback = profilesFile.profiles?.[GENERIC_PROFILE] ?? {
    tokenizer: "heuristic",
    context_window: GENERIC_CONTEXT_WINDOW,
  };
  warn(`unknown model_profile "${modelProfile}", using "${GENERIC_PROFILE}"`);
  return fallback;
}

//#endregion

//#region Scheme registry (DP-E §4.1, §4.3)

/** Counts one message body INCLUDING its per-message framing overhead (+4/+5 above). */
export type TokenizerFn = (text: string) => number;

const registry = new Map<string, TokenizerFn>();

/** Register a custom tokenizer scheme (e.g. "tiktoken-exact"); overwrite allowed (last wins). */
export function registerTokenizer(schemeName: string, fn: TokenizerFn): void {
  registry.set(schemeName, fn);
}

function warn(message: string): void {
  // Bounded, non-throwing diagnostics channel (GOV-RES-02 style); stderr only.
  console.warn(`[context] ${message}`);
}

//#endregion

//#region Built-in schemes (DP-E §4.3)

/**
 * "heuristic" — dependency-free default: chars/4 approximation plus +4 framing
 * tokens per message (role + framing). Zero deps (GOV-MIN-01/GOV-MIN-04).
 */
registerTokenizer("heuristic", (text) => {
  const len = typeof text === "string" ? text.length : 0;
  return Math.ceil(len / 4) + 4;
});

/**
 * "anthropic-heuristic" — same chars/4 body estimate, but +5 framing tokens
 * per message (Anthropic overhead observed in DP-E §4.5 calibration).
 */
registerTokenizer("anthropic-heuristic", (text) => {
  const len = typeof text === "string" ? text.length : 0;
  return Math.ceil(len / 4) + 5;
});

/**
 * "cl100k-heuristic" — exact cl100k_base encode via optional js-tiktoken when
 * installed; otherwise falls back to the "heuristic" scheme with a documented
 * <10% bias (DP-E §4.5 tolerance table). Optional dep only — never required.
 */
function makeCl100k(): TokenizerFn {
  try {
    // Synchronous require of the optional dep; ESM/CJS dual builds both work.
    const require_ = createRequire(import.meta.url);
    const mod = require_("js-tiktoken") as {
      getEncoding?: (name: string) => { encode: (t: string) => number[] | Uint8Array };
    };
    const enc = mod.getEncoding?.("cl100k_base");
    if (!enc) throw new Error("cl100k_base encoding unavailable");
    return (text) => {
      try {
        const len = typeof text === "string" ? text.length : 0;
        if (len === 0) return 4; // empty content: framing overhead only (§8)
        return enc.encode(text).length + 4; // +4 OpenAI-style per-message framing
      } catch {
        return registry.get("heuristic")!(text);
      }
    };
  } catch {
    warn("js-tiktoken not installed; cl100k-heuristic falls back to heuristic (<10% bias, DP-E §4.5)");
    return (text) => registry.get("heuristic")!(text);
  }
}
registerTokenizer("cl100k-heuristic", makeCl100k());

//#endregion

//#region Public API (DP-E §4.4)

/**
 * Count tokens for a raw text/binary input under the given model_profile.
 * Synchronous, pure, deterministic — no network, no LLM call (GOV-RES-04).
 * Unknown model_profile → warn + generic-heuristic; never throws (§8).
 */
export function count(input: string | Buffer, modelProfile: string): number {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const scheme = resolveProfile(modelProfile).tokenizer;
  const fn = registry.get(scheme) ?? registry.get("heuristic")!;
  try {
    return fn(text);
  } catch (e) {
    warn(`tokenizer "${scheme}" failed (${e instanceof Error ? e.message : String(e)}), using heuristic`);
    return registry.get("heuristic")!(text);
  }
}

/**
 * Count tokens for one buffer entry, honoring the optional per-message cache
 * `msg.token_count` when present (DP-E §4.6) instead of recomputing.
 */
export function countMessage(msg: Message, modelProfile: string): number {
  if (msg != null && typeof msg.token_count === "number" && Number.isFinite(msg.token_count)) {
    return msg.token_count;
  }
  const content = msg && typeof msg.content === "string" ? msg.content : "";
  return count(content, modelProfile);
}

/** Sum of per-message counts over an ordered buffer (index 0 = oldest). */
export function countBuffer(buffer: readonly Message[], modelProfile: string): number {
  if (!Array.isArray(buffer)) return 0;
  let total = 0;
  for (const msg of buffer) {
    total += countMessage(msg as Message, modelProfile);
  }
  return total;
}

/**
 * Budget arithmetic for a profile: { context_window, reserved_output,
 * input_budget } with `input_budget = max(0, context_window - reserved_output)`
 * (DP-E §5.1). context_window comes from contracts/tokenizer-profiles.json;
 * reservedOutput defaults to 1024 and is subtracted once, not per message.
 */
export function budget(
  modelProfile: string,
  reservedOutput?: number
): { context_window: number; reserved_output: number; input_budget: number } {
  const entry = resolveProfile(modelProfile);
  const reserved =
    typeof reservedOutput === "number" && Number.isFinite(reservedOutput)
      ? Math.max(0, Math.floor(reservedOutput))
      : 1024; // §11 checked-in default
  const contextWindow = Math.max(1, Math.floor(entry.context_window)); // positive integer, min 1
  return {
    context_window: contextWindow,
    reserved_output: reserved,
    input_budget: Math.max(0, contextWindow - reserved),
  };
}

//#endregion
