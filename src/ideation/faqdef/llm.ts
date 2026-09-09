// Requirement IDs: FAQDEF-RES-01, GOV-REU-02, GOV-RES-02, XCUT-08 | Owned by M14 step 4 (DP-D2b §5.3/§6.1)
// The ONLY LLM gateway of FAQDEF. Roles resolve against the SHARED
// config/model-profiles.json (faqdef_generator / faqdef_judge); provider/model
// strings are never hardcoded in module logic (GOV-REU-02). Every call goes
// through RES-01 withResilience({ timeout_ms: 20000, retries: 1 }) and returns
// string | DegradedResult — callers map degraded → fallback checklist.

import { readFileSync } from "node:fs";
import { withResilience } from "../../resilience/index.js";
import type { DegradedResult } from "../../resilience/index.js";
import type { ResilienceConfig } from "../../resilience/index.js";

const MODEL_PROFILES_PATH = "config/model-profiles.json";
const DEFAULT_FAQDEF_MODEL = "analyst-balanced";

/** Minimal callable contract injected by tests (stub) or the real provider call. */
export type FaqdefLlm = (input: string) => string | Promise<string>;

//#region Model resolution (GOV-REU-02 — never hardcoded)

let warnedModelFallback = false;

/** Resolve role → model profile name from the shared model-profiles file.
 * Absent/malformed → warn ONCE + safe default; never throws (GOV-RES-02). */
export function getModelForRole(role: string): string {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_PROFILES_PATH, "utf8")) as Record<string, unknown>;
    const candidates: unknown[] = [
      parsed[role],
      (parsed["roles"] as Record<string, unknown> | undefined)?.[role],
      (parsed["profiles"] as Record<string, unknown> | undefined)?.[role],
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
      if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        const model = obj["model"] ?? obj["model_profile"];
        if (typeof model === "string" && model.trim()) return model.trim();
      }
    }
  } catch {
    /* fall through to warn + default */
  }
  if (!warnedModelFallback) {
    warnedModelFallback = true;
    console.warn(`warn: config/model-profiles.json has no "${role}" entry; using ${DEFAULT_FAQDEF_MODEL}`);
  }
  return DEFAULT_FAQDEF_MODEL;
}

//#endregion

//#region Real provider call (offline-safe: throws → wrapper degrades → checklist)

/** Default network call (OpenAI-compatible chat completions, JSON mode).
 * Requires OPENAI_API_KEY; any absence/network/HTTP failure THROWS so the
 * RES-01 wrapper converts it into DegradedResult → checklist fallback.
 * Never called when callLlm is injected (tests, offline runs). */
export async function defaultCallLlm(role: string, prompt: string): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(`OPENAI_API_KEY not set — role ${role} cannot reach an LLM (offline path)`);
  }
  const baseUrl = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
  const model = getModelForRole(role);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`faqdef LLM HTTP ${res.status}`);
  const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("faqdef LLM returned empty content");
  return content;
}

//#endregion

//#region RES-01 wrapping

const FALLBACK_CONFIG: ResilienceConfig = {
  timeout_ms: 20_000,
  retries: 1,
  backoff: { policy: "exponential", base_ms: 500 },
  fallback_chain: { order: ["none"] },
};

/**
 * resilientFaqdefCall — single RES-01 gateway:
 * withResilience(() => callLlm(prompt), { timeout_ms: 20000, retries: 1,
 * backoff exponential base 500ms, fallback_chain ["none"] }).
 */
export function resilientFaqdefCall(
  callLlm: FaqdefLlm,
  prompt: string,
  overrides: { timeout_ms?: number; retries?: number } = {},
): () => Promise<string | DegradedResult<string>> {
  const config: ResilienceConfig = {
    ...FALLBACK_CONFIG,
    ...(overrides.timeout_ms !== undefined ? { timeout_ms: overrides.timeout_ms } : {}),
    ...(overrides.retries !== undefined ? { retries: overrides.retries } : {}),
  };
  return withResilience(() => Promise.resolve(callLlm(prompt)), config);
}

//#endregion
