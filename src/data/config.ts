// Requirement IDs: DATA-01, DATA-03, GOV-RES-02
// Config resolution for the synthetic demo-data generator — DP-H §6 / §7.3.
//
// - Deep-merges caller config over checked-in src/data/defaults.json.
// - Resolves role→model_profile via THE shared config/model-profiles.json
//   (PGM-11 — read-only; exactly one routing file exists, never a second one).
// - Validates the merged config with RES-04 validate() imported from
//   src/resilience against contracts/data-generator-config.schema.json
//   (DATA-04 reuse — no bespoke validator).
// - Missing/malformed anything → console.warn ONCE + safe default substituted;
//   resolution NEVER throws (GOV-RES-02, RES-AC-04 pattern).
// - Provider-agnostic (RES-REU-02): provider always comes from the selected
//   profile's "provider" field; no provider names appear in this module.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "src/resilience";
import type { ResilienceConfig } from "src/resilience";
import type { DataGeneratorConfig } from "./types.js";

const DATA_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DATA_DIR, "..", "..");
const DEFAULTS_PATH = join(DATA_DIR, "defaults.json");
const MODEL_PROFILES_PATH = join(REPO_ROOT, "config", "model-profiles.json");
const CONFIG_SCHEMA_PATH = join(REPO_ROOT, "contracts", "data-generator-config.schema.json");
const RESILIENCE_SCHEMA_PATH = join(REPO_ROOT, "contracts", "resilience-config.schema.json");

export const DEFAULT_ROLE = "data-generator"; // §6.1 roles key owned by DATA
export const DEFAULT_MODEL_PROFILE = "balanced"; // §7.3 baked-in fallback

//#region Types

/** Fully-resolved data-generator configuration (every knob concrete). */
export interface ResolvedConfig {
  role: string;
  /** Profile NAME resolved from the shared file (e.g. "balanced"). */
  modelProfile: string;
  /** Provider taken verbatim from the profile's "provider" field — never hardcoded here. */
  provider?: string;
  /** Model id from the profile, for traceability/logging only. */
  model?: string;
  contextWindow?: number;
  resilience: ResilienceConfig;
  batch: { maxCount: number; truncateFieldChars: number };
  watermark: {
    enabled: boolean;
    allowDisableWatermark: boolean;
    headerText: string;
  };
  cache: { enabled: boolean; dir?: string };
}

//#endregion

//#region Warn-once helpers (GOV-RES-02 — noisy failures degrade quietly)

let warnedFileFallback = false;
function warnOnce(msg: string): void {
  if (!warnedFileFallback) {
    warnedFileFallback = true;
    console.warn(`[data] warn: ${msg}`);
  }
}

/** Strips "$comment" metadata keys anywhere in a parsed JSON tree (they are
 *  documentation, never config, and would trip additionalProperties:false). */
function stripCommentKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripCommentKeys);
  if (!isObj(node)) return node;
  const out: JsonObj = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$comment") continue;
    out[k] = stripCommentKeys(v);
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = stripCommentKeys(JSON.parse(readFileSync(path, "utf8")));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnOnce(`${path} is not a JSON object; using safe defaults`);
  } catch {
    warnOnce(`${path} absent/malformed; using safe defaults`);
  }
  return null;
}

//#endregion

//#region In-memory baked fallbacks (used only when files are missing/malformed)

/** §7.3 — mirrors defaults.json; used when the checked-in file cannot be read. */
const BAKED_DEFAULTS: ResolvedConfig = {
  role: DEFAULT_ROLE,
  modelProfile: DEFAULT_MODEL_PROFILE,
  resilience: {
    timeout_ms: 30000,
    retries: 2,
    backoff: { policy: "exponential", base_ms: 500, factor: 2.0, max_ms: 5000, jitter: true },
    fallback_chain: { order: ["replay", "cache", "none"] },
    cache_key_strategy: "auto",
  },
  batch: { maxCount: 200, truncateFieldChars: 4000 },
  watermark: {
    enabled: true,
    allowDisableWatermark: false,
    headerText: "SYNTHETIC DEMO DATA — NOT REAL",
  },
  cache: { enabled: false },
};

/** Shared-file fallback per §7.3: baked profile shapes; provider always comes from config. */
interface ModelProfile {
  provider?: string;
  model?: string;
  context_window?: number;
}
const BAKED_PROFILES: Record<string, ModelProfile> = {
  fast: { model: "gpt-4o-mini", context_window: 128000 },
  balanced: { model: "gpt-4o", context_window: 128000 },
  quality: { model: "claude-3-5-sonnet-20241022", context_window: 200000 },
};

//#endregion

//#region Shared role→model_profile file (PGM-11 — read-only, exactly one file)

/**
 * Reads the shared config/model-profiles.json. Tolerates the canonical shape
 * ({profiles, roles}) plus flat/direct-key shapes defensively, mirroring the
 * advisor reader. Returns null when absent/malformed — caller falls back to
 * baked defaults (§7.3), never throws.
 */
function loadModelProfiles(): { profiles: Record<string, ModelProfile>; roles: Record<string, string> } | null {
  const parsed = readJson(MODEL_PROFILES_PATH);
  if (!parsed) return null;
  const profilesOut: Record<string, ModelProfile> = {};
  const rolesOut: Record<string, string> = {};
  const rawProfiles = isObj(parsed["profiles"]) ? parsed["profiles"] : parsed; // flat fallback
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!isObj(value)) continue;
    const p: ModelProfile = {};
    if (typeof value["provider"] === "string") p.provider = value["provider"];
    if (typeof value["model"] === "string") p.model = value["model"];
    if (typeof value["context_window"] === "number") p.context_window = value["context_window"];
    if (Object.keys(p).length > 0) profilesOut[name] = p;
  }
  const rawRoles = isObj(parsed["roles"])
    ? parsed["roles"]
    : Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string"));
  for (const [role, target] of Object.entries(rawRoles)) {
    if (typeof target === "string" && target.trim() && profilesOut[target.trim()]) {
      rolesOut[role] = target.trim();
    }
  }
  return { profiles: profilesOut, roles: rolesOut };
}

//#endregion

//#region Deep merge (plain objects only; arrays and non-objects replace)

type JsonObj = Record<string, unknown>;
function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObj(override)) return base;
  if (!isObj(base)) return structuredClone(override) as T;
  const out: JsonObj = { ...(base as JsonObj) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out as T;
}

//#endregion

//#region RES-04 schema loading (contracts via $ref, never duplicated)

/**
 * Loads contracts/data-generator-config.schema.json and inlines its single
 * external $ref (resilience-config) by reading that contract file too — both
 * stay single-source; nothing is copied into code. Returns null when either
 * file is unreadable, in which case structural fallback checks apply.
 */
function loadConfigSchema(): object | null {
  const schema = readJson(CONFIG_SCHEMA_PATH);
  if (!schema) return null;
  const REF = "https://chassis/contracts/resilience-config.schema.json";
  const resilienceSchema = readJson(RESILIENCE_SCHEMA_PATH);
  if (JSON.stringify(schema).includes(REF)) {
    if (!resilienceSchema) return null; // cannot honor the $ref → skip strict validation
    return inlineRef(schema, REF, resilienceSchema);
  }
  return schema;
}

function inlineRef(node: unknown, ref: string, replacement: unknown): object {
  if (Array.isArray(node)) return node.map((n) => inlineRef(n, ref, replacement));
  if (!isObj(node)) return node as object;
  if (node["$ref"] === ref) return inlineRef(replacement, ref, replacement);
  const out: JsonObj = {};
  for (const [k, v] of Object.entries(node)) out[k] = isObj(v) || Array.isArray(v) ? inlineRef(v, ref, replacement) : v;
  return out;
}

/** True when value passes the given subschema (or, if schemas are unavailable, basic sanity). */
function sectionValid(schema: object | null, section: string, value: unknown): boolean {
  if (schema) {
    const props = isObj((schema as JsonObj)["properties"]) ? ((schema as JsonObj)["properties"] as JsonObj)[section] : undefined;
    if (isObj(props)) return validate({ type: "object", properties: { [section]: props } }, { [section]: value }).valid;
  }
  return isObj(value); // schema-less structural fallback: sections must be objects
}

//#endregion

//#region Resolution (DP-H §6 / §7.3)

/** Working view in the CONTRACT's shape (snake_case model_profile), pre-profile-resolution. */
function bakedView(): Record<string, unknown> {
  return {
    role: BAKED_DEFAULTS.role,
    resilience: structuredClone(BAKED_DEFAULTS.resilience),
    batch: structuredClone(BAKED_DEFAULTS.batch),
    watermark: structuredClone(BAKED_DEFAULTS.watermark),
    cache: structuredClone(BAKED_DEFAULTS.cache),
  };
}

const SECTION_KEYS = ["resilience", "batch", "watermark", "cache"];
const STRING_KEYS = ["role", "model_profile", "provider"];

/**
 * resolveConfig(config?) — never throws. Layering (lowest → highest):
 * baked fallbacks → checked-in defaults.json → caller config (per-section,
 * invalid sections warned + dropped) → shared-file profile resolution.
 */
export function resolveConfig(config?: DataGeneratorConfig): ResolvedConfig {
  const schema = loadConfigSchema();
  const fileDefaults = readJson(DEFAULTS_PATH);
  let view = deepMerge(bakedView(), fileDefaults);
  const user: Record<string, unknown> = { ...(config as Record<string, unknown> | undefined) };

  for (const [k, v] of Object.entries(user)) {
    if (STRING_KEYS.includes(k)) {
      if (typeof v === "string" && v.trim()) view[k] = v.trim();
      else warnOnce(`config.${k} must be a non-empty string; keeping safe default`);
    } else if (SECTION_KEYS.includes(k)) {
      const candidate = deepMerge(view[k], v);
      if (sectionValid(schema, k, candidate)) view[k] = candidate;
      else warnOnce(`config.${k} failed schema validation; substituting safe default (GOV-RES-02)`);
    } else {
      warnOnce(`unknown config key "${k}" ignored`);
    }
  }

  // Whole-object RES-04 check against the frozen contract (DATA-04 reuse).
  if (schema) {
    const res = validate(schema, view);
    if (!res.valid) {
      warnOnce(
        `merged config failed contracts/data-generator-config.schema.json (${String(res.errors.length)} error(s)); using pure defaults`,
      );
      view = bakedView();
    }
  }

  // role → model_profile via THE shared file (PGM-11). Explicit model_profile wins.
  const role = typeof view["role"] === "string" && view["role"].trim() ? (view["role"] as string).trim() : DEFAULT_ROLE;
  const shared = loadModelProfiles();
  const explicit = typeof view["model_profile"] === "string" ? (view["model_profile"] as string).trim() : "";
  const fileDefaultProfile = typeof fileDefaults?.["model_profile"] === "string" ? (fileDefaults["model_profile"] as string).trim() : "";
  let profileName =
    explicit || shared?.roles[role] || shared?.roles[DEFAULT_ROLE] || fileDefaultProfile || DEFAULT_MODEL_PROFILE;

  const profiles = shared?.profiles ?? BAKED_PROFILES;
  let profile: ModelProfile = profiles[profileName] ?? {};
  if (!profile) {
    warnOnce(`unknown model_profile "${profileName}"; falling back to "${DEFAULT_MODEL_PROFILE}" (RES-AC-04)`);
    profileName = DEFAULT_MODEL_PROFILE;
    profile = profiles[profileName] ?? {};
  }

  return {
    role,
    modelProfile: profileName,
    provider: typeof view["provider"] === "string" ? (view["provider"] as string) : profile.provider,
    model: profile.model,
    contextWindow: profile.context_window,
    resilience: structuredClone(view["resilience"]) as ResilienceConfig,
    batch: structuredClone(view["batch"]) as ResolvedConfig["batch"],
    watermark: structuredClone(view["watermark"]) as ResolvedConfig["watermark"],
    cache: structuredClone(view["cache"]) as ResolvedConfig["cache"],
  };
}

/** Profile-name-only convenience used later by generate.ts (DP-H §7.1). Never throws. */
export function resolveModelProfile(config?: DataGeneratorConfig): string {
  return resolveConfig(config).modelProfile;
}

//#endregion
