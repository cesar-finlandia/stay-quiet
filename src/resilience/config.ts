// Requirement IDs: RES-02, RES-03, RES-07, RES-AC-04, GOV-RES-02, RES-RES-03, XCUT-08
// Configuration system for the resilience layer (DP-A §3.2, §4.2, §7).
// Precedence (lowest → highest): defaults.json → per-call ResilienceConfig → env vars.
// Never throws: malformed fields warn + substitute defaults (§7.4); corrupt/missing
// defaults.json falls back to hardcoded FALLBACK_DEFAULTS (defaults.ts).
// Domain-free (GOV-REU-02); imports only node stdlib + sibling modules (RES-REU-01).

// Node builtins resolved lazily via node-compat (see cache/store.ts): the
// barrel is imported by browser bundles (UI isDegraded path), so static
// node:* imports must not appear in this module's evaluation graph.
type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");
type UrlModule = typeof import("node:url");
const fsMod = nodeBuiltin<FsModule>("node:fs");
const pathMod = nodeBuiltin<PathModule>("node:path");
const urlMod = nodeBuiltin<UrlModule>("node:url");
import { nodeBuiltin } from "./node-compat.js";
import { FALLBACK_DEFAULTS } from "./defaults.js";

//#region Types (DP-A §4.2)

export type BackoffPolicy = "exponential" | "linear" | "fixed" | "none";
export type FallbackStep = "secondary_provider" | "cache" | "replay" | "none";
export type CacheKeyStrategy = "auto" | "explicit";

export interface ResilienceConfig {
  timeout_ms?: number; // default 15000, min 100, max 1800000
  retries?: number; // default 2, min 0, max 5
  backoff?: BackoffConfig;
  fallback_chain?: FallbackChainConfig;
  cache_key_strategy?: CacheKeyStrategy; // default "auto"
  cache_key_explicit?: string; // required iff strategy=="explicit"
  forced_degraded?: boolean; // default false — kill switch RES-07
}

export interface BackoffConfig {
  policy?: BackoffPolicy;
  base_ms?: number; // min 10
  factor?: number; // min 1.0
  max_ms?: number;
  jitter?: boolean;
}

export interface FallbackStepConfig {
  enabled?: boolean;
}

export interface FallbackChainConfig {
  order?: FallbackStep[]; // default ["cache","replay","none"]
  secondary_provider?: FallbackStepConfig; // default {enabled:false}
  cache?: FallbackStepConfig; // default {enabled:true}
  replay?: FallbackStepConfig; // default {enabled:true}
  none?: { enabled?: true }; // always true (terminal)
}

/** Fully-resolved nested shapes (TS Required<> is shallow, so spelled out). */
export interface EffectiveConfig {
  timeout_ms: number;
  retries: number;
  backoff: Required<BackoffConfig>;
  fallback_chain: {
    order: FallbackStep[];
    secondary_provider: Required<FallbackStepConfig>;
    cache: Required<FallbackStepConfig>;
    replay: Required<FallbackStepConfig>;
    none: { enabled: true };
  };
  cache_key_strategy: CacheKeyStrategy;
  cache_key_explicit: string;
  forced_degraded: boolean;
}

//#endregion

//#region Internal helpers

type WarnFn = (message: string) => void;

let warnFn: WarnFn = (message) => console.warn(`[resilience] warn: ${message}`);

/** Test seam: override the warn sink. Returns the previous sink. */
export function setWarnLogger(fn: WarnFn): WarnFn {
  const prev = warnFn;
  warnFn = fn;
  return prev;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

//#endregion

//#region Global defaults loading (DP-A §7.4)

function defaultsPath(): string | null {
  if (!pathMod || !urlMod) return null; // browser: no defaults.json read (§7.4 fallback)
  const filePath = urlMod.fileURLToPath(new URL("./defaults.json", import.meta.url));
  return pathMod.join(pathMod.dirname(filePath), "defaults.json");
}

let cachedGlobals: EffectiveConfig | null = null;

/**
 * Load global defaults from defaults.json (read once, then cached).
 * Missing/unreadable/corrupt file → hardcoded FALLBACK_DEFAULTS (§7.4).
 */
export function loadGlobalDefaults(): EffectiveConfig {
  if (cachedGlobals) return cachedGlobals;
  try {
    if (!fsMod) throw new Error("defaults.json requires a Node runtime");
    const raw = JSON.parse(fsMod.readFileSync(defaultsPath()!, "utf8"));
    if (!isRecord(raw)) throw new Error("defaults.json root is not an object");
    // Path-aware lookup (same helper as resolveConfig): nested normalization
    // queries e.g. "backoff.policy" and must receive the nested default, not
    // the whole FALLBACK_DEFAULTS record.
    cachedGlobals = normalizeConfig(raw, fallbackLookup);
  } catch (err) {
    warnFn(
      `resilience defaults.json unreadable or corrupt (${err instanceof Error ? err.message : String(err)}), using hardcoded in-memory defaults`,
    );
    cachedGlobals = FALLBACK_DEFAULTS;
  }
  return cachedGlobals;
}

//#endregion

//#region Env overrides (DP-A §7.1 precedence tier 3)

const TIMEOUT_MIN = 100;
// Raised from the DP-A-era 120000: agentic transports (PGM sweep chat turns)
// legitimately run for minutes; the wrapper must accept their budgets.
const TIMEOUT_MAX = 1_800_000;
const RETRIES_MIN = 0;
const RETRIES_MAX = 5;

/**
 * Apply operator env vars over an already-normalized config (env wins):
 * RES_FORCED_DEGRADED=1, RES_TIMEOUT_MS, RES_RETRIES.
 * Invalid env values warn + are ignored — never throw (§7.4).
 */
function applyEnvOverrides(effective: EffectiveConfig, source: NodeJS.ProcessEnv): void {
  const forced = source["RES_FORCED_DEGRADED"];
  if (forced !== undefined && forced !== "") {
    if (forced === "1") {
      effective.forced_degraded = true;
    } else {
      warnFn(
        `resilience config field RES_FORCED_DEGRADED invalid (${forced}), using default ${String(effective.forced_degraded)}; expected "1"`,
      );
    }
  }

  const timeout = source["RES_TIMEOUT_MS"];
  if (timeout !== undefined && timeout !== "") {
    const parsed = Number(timeout);
    if (asFiniteInt(parsed) && parsed >= TIMEOUT_MIN && parsed <= TIMEOUT_MAX) {
      effective.timeout_ms = parsed;
    } else {
      warnFn(`resilience config field RES_TIMEOUT_MS invalid (${timeout}), using default ${String(effective.timeout_ms)}`);
    }
  }

  const retries = source["RES_RETRIES"];
  if (retries !== undefined && retries !== "") {
    const parsed = Number(retries);
    if (asFiniteInt(parsed) && parsed >= RETRIES_MIN && parsed <= RETRIES_MAX) {
      effective.retries = parsed;
    } else {
      warnFn(`resilience config field RES_RETRIES invalid (${retries}), using default ${String(effective.retries)}`);
    }
  }
}

//#endregion

//#region Structural validation / normalization
// Thin local structural check mirroring contracts/resilience-config.schema.json.
// Step 4 (RES-04) swaps this for the shared schema validator; the warn-and-
// substitute-default contract below stays identical either way.

const BACKOFF_POLICIES: readonly BackoffPolicy[] = ["exponential", "linear", "fixed", "none"];
const FALLBACK_STEPS: readonly FallbackStep[] = ["secondary_provider", "cache", "replay", "none"];
const CACHE_KEY_STRATEGIES: readonly CacheKeyStrategy[] = ["auto", "explicit"];

function invalid<T>(path: string, value: unknown, fallback: T): T {
  warnFn(
    `resilience config field ${path} invalid (${typeof value === "object" ? JSON.stringify(value) : String(value)}), using default ${typeof fallback === "object" ? JSON.stringify(fallback) : String(fallback)}`,
  );
  return fallback;
}

/**
 * Normalize an arbitrary parsed config object into a full EffectiveConfig.
 * Missing fields → fallback lookup; malformed fields → warn + fallback
 * substitution; unknown keys → warn + ignore. Never throws (§7.4).
 * `fallbackFor` supplies the checked-in default for a given field path.
 */
function normalizeConfig(raw: Record<string, unknown>, fallbackFor: (path: string) => unknown): EffectiveConfig {
  const out = {} as EffectiveConfig;

  for (const key of Object.keys(raw)) {
    if (!(key in FALLBACK_DEFAULTS)) {
      warnFn(`resilience config field ${key} unknown, ignoring`);
    }
  }

  // timeout_ms: integer [100, 1800000]
  const t = raw["timeout_ms"];
  out.timeout_ms =
    t === undefined ? (fallbackFor("timeout_ms") as number)
    : asFiniteInt(t) && t >= TIMEOUT_MIN && t <= TIMEOUT_MAX ? t
    : invalid("timeout_ms", t, fallbackFor("timeout_ms") as number);

  // retries: integer [0, 5]
  const r = raw["retries"];
  out.retries =
    r === undefined ? (fallbackFor("retries") as number)
    : asFiniteInt(r) && r >= RETRIES_MIN && r <= RETRIES_MAX ? r
    : invalid("retries", r, fallbackFor("retries") as number);

  // backoff
  const rawBackoff = raw["backoff"];
  const fbBackoff = fallbackFor("backoff") as EffectiveConfig["backoff"];
  if (rawBackoff === undefined) {
    out.backoff = { ...fbBackoff };
  } else if (!isRecord(rawBackoff)) {
    out.backoff = invalid("backoff", rawBackoff, { ...fbBackoff });
  } else {
    for (const k of Object.keys(rawBackoff)) {
      if (!(k in fbBackoff)) warnFn(`resilience config field backoff.${k} unknown, ignoring`);
    }
    const policy = rawBackoff["policy"];
    out.backoff = {
      policy:
        policy === undefined ? fbBackoff.policy
        : typeof policy === "string" && (BACKOFF_POLICIES as readonly string[]).includes(policy) ? (policy as BackoffPolicy)
        : invalid("backoff.policy", policy, fbBackoff.policy),
      base_ms:
        rawBackoff["base_ms"] === undefined ? fbBackoff.base_ms
        : asFiniteInt(rawBackoff["base_ms"]) && (rawBackoff["base_ms"] as number) >= 10 ? (rawBackoff["base_ms"] as number)
        : invalid("backoff.base_ms", rawBackoff["base_ms"], fbBackoff.base_ms),
      factor:
        rawBackoff["factor"] === undefined ? fbBackoff.factor
        : typeof rawBackoff["factor"] === "number" && Number.isFinite(rawBackoff["factor"]) && (rawBackoff["factor"] as number) >= 1.0 ? (rawBackoff["factor"] as number)
        : invalid("backoff.factor", rawBackoff["factor"], fbBackoff.factor),
      max_ms:
        rawBackoff["max_ms"] === undefined ? fbBackoff.max_ms
        : asFiniteInt(rawBackoff["max_ms"]) ? (rawBackoff["max_ms"] as number)
        : invalid("backoff.max_ms", rawBackoff["max_ms"], fbBackoff.max_ms),
      jitter:
        rawBackoff["jitter"] === undefined ? fbBackoff.jitter
        : typeof rawBackoff["jitter"] === "boolean" ? (rawBackoff["jitter"] as boolean)
        : invalid("backoff.jitter", rawBackoff["jitter"], fbBackoff.jitter),
    };
  }

  // fallback_chain
  const rawChain = raw["fallback_chain"];
  const fbChain = fallbackFor("fallback_chain") as EffectiveConfig["fallback_chain"];
  if (rawChain === undefined) {
    out.fallback_chain = JSON.parse(JSON.stringify(fbChain)) as EffectiveConfig["fallback_chain"];
  } else if (!isRecord(rawChain)) {
    out.fallback_chain = invalid("fallback_chain", rawChain, JSON.parse(JSON.stringify(fbChain)));
  } else {
    for (const k of Object.keys(rawChain)) {
      if (!(k in fbChain)) warnFn(`resilience config field fallback_chain.${k} unknown, ignoring`);
    }
    const rawOrder = rawChain["order"];
    const validOrder =
      Array.isArray(rawOrder) && rawOrder.every((s) => typeof s === "string" && (FALLBACK_STEPS as readonly string[]).includes(s));
    const step = (name: Exclude<FallbackStep, "none">): { enabled: boolean } => {
      const rawStep = rawChain[name];
      const fbEnabled = fbChain[name].enabled;
      if (rawStep === undefined) return { enabled: fbEnabled };
      if (
        !isRecord(rawStep) ||
        Object.keys(rawStep).some((k2) => !(k2 in fbChain[name])) ||
        (rawStep["enabled"] !== undefined && typeof rawStep["enabled"] !== "boolean")
      ) {
        return invalid(`fallback_chain.${name}`, rawStep, { enabled: fbEnabled });
      }
      return { enabled: rawStep["enabled"] === undefined ? fbEnabled : (rawStep["enabled"] as boolean) };
    };
    out.fallback_chain = {
      order:
        rawOrder === undefined ? [...fbChain.order]
        : validOrder ? (rawOrder as FallbackStep[])
        : invalid("fallback_chain.order", rawOrder, [...fbChain.order]),
      secondary_provider: step("secondary_provider"),
      cache: step("cache"),
      replay: step("replay"),
      // terminal step is always enabled — schema pins enabled to true
      none: { enabled: true },
    };
  }

  // cache_key_strategy (+ conditional cache_key_explicit per schema allOf)
  const strategy = raw["cache_key_strategy"];
  const fbStrategy = fallbackFor("cache_key_strategy") as CacheKeyStrategy;
  let effStrategy =
    strategy === undefined ? fbStrategy
    : typeof strategy === "string" && (CACHE_KEY_STRATEGIES as readonly string[]).includes(strategy) ? (strategy as CacheKeyStrategy)
    : invalid("cache_key_strategy", strategy, fbStrategy);

  const rawExplicitKey = raw["cache_key_explicit"];
  let effExplicitKey: string;
  if (rawExplicitKey === undefined) {
    effExplicitKey = fallbackFor("cache_key_explicit") as string;
  } else if (typeof rawExplicitKey !== "string") {
    effExplicitKey = invalid("cache_key_explicit", rawExplicitKey, "");
  } else {
    // empty string is legal (= unset); explicit-strategy precondition checked below
    effExplicitKey = rawExplicitKey;
  }
  if (effStrategy === "explicit" && effExplicitKey.length === 0) {
    // strategy precondition broken → warn and fall back to "auto"
    warnFn("resilience config field cache_key_strategy invalid (explicit without usable cache_key_explicit), using default auto");
    effStrategy = "auto";
  }
  out.cache_key_strategy = effStrategy;
  out.cache_key_explicit = effExplicitKey;

  // forced_degraded
  const fd = raw["forced_degraded"];
  out.forced_degraded =
    fd === undefined ? (fallbackFor("forced_degraded") as boolean)
    : typeof fd === "boolean" ? fd
    : invalid("forced_degraded", fd, fallbackFor("forced_degraded") as boolean);

  return out;
}

//#endregion

//#region Resolution (DP-A §3.2: resolve ONCE at wrapper creation)

/**
 * Resolve a fully-validated EffectiveConfig from all three precedence tiers:
 * defaults.json < per-call config (shallow merge, per-call wins) < env vars.
 * Accepts undefined/null/{} → all defaults (RES-AC-04). Never throws.
 */
export function resolveConfig(
  perCall?: ResilienceConfig | null,
  env?: NodeJS.ProcessEnv,
): EffectiveConfig {
  const globals = loadGlobalDefaults();

  let merged: Record<string, unknown>;
  if (perCall === undefined || perCall === null) {
    merged = JSON.parse(JSON.stringify(globals)) as Record<string, unknown>;
  } else if (!isRecord(perCall as unknown)) {
    warnFn(`resilience config field (per-call) invalid (${String(perCall)}), using global defaults`);
    merged = JSON.parse(JSON.stringify(globals)) as Record<string, unknown>;
  } else {
    // shallow top-level merge: per-call wins; nested objects are replaced wholesale
    // (unset nested keys then fall back to checked-in defaults during normalization)
    const perCallRecord = perCall as unknown as Record<string, unknown>;
    for (const key of Object.keys(perCallRecord)) {
      if (!(key in FALLBACK_DEFAULTS)) {
        warnFn(`resilience config field ${key} unknown, ignoring`);
      }
    }
    merged = { ...JSON.parse(JSON.stringify(globals)), ...perCallRecord };
  }

  const effective = normalizeConfig(merged, fallbackLookup);
  applyEnvOverrides(effective, env ?? process.env);
  return effective;
}

/** Field-path lookup into the hardcoded fallback defaults (used by normalization). */
function fallbackLookup(path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = FALLBACK_DEFAULTS;
  for (const part of parts) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Resolve the config ONCE at wrapper creation and hand back an accessor that
 * returns the same cached EffectiveConfig on every hot-path call (§3.2).
 */
export function createConfigResolver(perCall?: ResilienceConfig | null): () => EffectiveConfig {
  const effective = Object.freeze(resolveConfig(perCall));
  return () => effective;
}

//#endregion
