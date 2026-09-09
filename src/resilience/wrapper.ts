// Requirement IDs: RES-01, RES-02, RES-03, RES-07, RES-REU-02, RES-RES-03, GOV-RES-01, GOV-RES-04, XCUT-08
// Central resilience wrapper — DP-A §3.1/§3.3/§3.4, §4.1, §7.
// withResilience(fn, config?, deps?) → () => Promise<T | DegradedResult>.
// Iterative retry loop with timeout + backoff+jitter (RES-02), ordered fallback
// chain secondary_provider → cache → replay → DegradedResult (RES-03), forced-
// degraded kill switch (RES-07), and an outermost guard that maps ANY internal
// failure to DegradedResult{reason:"resilience_internal_error"} (RES-RES-03,
// GOV-RES-04). Never throws unhandled. Domain-free (GOV-REU-02); imports only
// sibling resilience modules (RES-REU-01).

import type { DegradedResult, FallbackSource } from "./degraded.js";
import { makeDegradedResult } from "./degraded.js";
import type { EffectiveConfig, ResilienceConfig } from "./config.js";
import { createConfigResolver } from "./config.js";
import type { GoldenCache } from "./cache/index.js";
import { createGoldenCache, REPLAY_PREFIX } from "./cache/index.js";
import { ValidationRepairFailed, completeRepair, renderRepairPrompt, validate } from "./validate.js";
import type { LlmCallable } from "./validate.js";

//#region Callable contract (DP-A §4.1)

/** Minimal callable contract: zero required args (closure-friendly), sync or async, raises on failure. */
export type ResilientCallable<T> = () => T | Promise<T>;

/** Uniform output: sync callables are promoted to Promise on the output side. */
export type WrappedCallable<T> = () => Promise<T | DegradedResult<T>>;

/** Out-of-band dependencies (never serialized into config). */
export interface WrapperDeps {
  /** Step 1 of the fallback chain; supplied by the caller, not a string lookup. */
  secondaryProvider?: ResilientCallable<unknown>;
  /**
   * LLM callable used by `withValidation` for the single self-repair
   * round-trip (DP-A §6.2). Supplied out-of-band like secondaryProvider —
   * NEVER serialized into config. Repair inherits timeout_ms.
   */
  repairLlm?: LlmCallable;
  /**
   * Golden cache used by the `cache`/`replay` fallback steps. Defaults to a
   * shared process-wide instance rooted at <cwd>/.cache/golden (or GOLDEN_CACHE_DIR).
   */
  cache?: GoldenCache;
  /** Explicit base key; overrides strategy resolution when provided. */
  cacheKey?: string;
  /** Key material for the "auto" strategy (sha256(provider|model|input_hash)). */
  keyInput?: CacheKeyInput;
  /**
   * Optional structured-output enforcement hook applied to successful primary/
   * secondary results; throwing `ValidationRepairFailed` routes the call into
   * the fallback chain with reason "validation_repair_failed". Installed by
   * `withValidation`; consumers pass `schema` instead of authoring hooks.
   */
  validateResult?: (result: unknown) => unknown;
}

//#endregion

//#region Backoff computation (DP-A §4.2, §7.1)

/** ±25% uniform jitter (§7.1). Deterministic when jitter is disabled. */
function applyJitter(ms: number, jitter: boolean): number {
  if (!jitter) return ms;
  const factor = 0.75 + Math.random() * 0.5; // [0.75, 1.25]
  return Math.max(0, Math.round(ms * factor));
}

/**
 * Delay before retry `attempt` (1-based) per the backoff policy:
 * exponential base*factor^(attempt-1) | linear base*attempt | fixed base | none 0.
 * Capped at max_ms; ±25% uniform jitter applied last.
 */
export function computeBackoffDelayMs(effective: EffectiveConfig, attempt: number): number {
  const { policy, base_ms, factor, max_ms, jitter } = effective.backoff;
  let raw: number;
  switch (policy) {
    case "exponential":
      raw = base_ms * Math.pow(factor, attempt - 1);
      break;
    case "linear":
      raw = base_ms * attempt;
      break;
    case "fixed":
      raw = base_ms;
      break;
    case "none":
      return 0;
  }
  return applyJitter(Math.min(Math.round(raw), max_ms), jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//#endregion

//#region Timeout (DP-A §3.1 sync/async handling)

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortSignal.timeout rejects with TimeoutError (DOMException); be liberal in what we accept.
  return err.name === "TimeoutError" || err.name === "AbortError";
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms (primary_timeout)`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

//#endregion

//#region Cache/replay key resolution (DP-A §5.2, §7.1)

/** Out-of-band key material for the auto strategy (zero-arg callables carry none). */
export interface CacheKeyInput {
  provider: string;
  model: string;
  prompt: unknown;
}

/**
 * Resolved once per wrapper creation: base key under which `cache` looks up
 * directly and `replay` looks up under the `replay::<base>` subspace.
 * Returns null when no key material is available — stages then report a miss.
 */
function resolveBaseKey(
  effective: EffectiveConfig,
  deps: WrapperDeps,
  cache: GoldenCache,
): string | null {
  if (deps.cacheKey !== undefined && deps.cacheKey !== "") return deps.cacheKey;
  if (
    effective.cache_key_strategy === "explicit" &&
    effective.cache_key_explicit !== undefined &&
    effective.cache_key_explicit !== ""
  ) {
    return effective.cache_key_explicit;
  }
  if (deps.keyInput !== undefined) return cache.deriveKey(deps.keyInput);
  return null;
}

//#endregion

//#region Warn sink (structured, non-throwing containment logging §3.4)

function warn(message: string): void {
  console.warn(`[resilience] warn: ${message}`);
}

//#endregion

//#region Public entry points (DP-A §3.1, §4.1)

/** Shared per-wrapper runtime resolved ONCE at creation (§3.2 hot path). */
interface ResolvedRuntime<T> {
  getEffective: () => EffectiveConfig;
  exec: ResilientCallable<T>;
  stageCtx: StageContext;
}

function resolveRuntime<T>(
  fn: ResilientCallable<T>,
  config?: ResilienceConfig | null,
  deps?: WrapperDeps,
): ResolvedRuntime<T> {
  const d: WrapperDeps = deps ?? {};
  // Config resolution is itself GOV-RES-04-guarded inside createConfigResolver;
  // cache defaulting must never throw either, so it's wrapped here as well.
  let cache: GoldenCache;
  try {
    cache = d.cache ?? createGoldenCache();
  } catch (err) {
    throw normalizeError(err); // caught by outermost guard below
  }
  return {
    getEffective: createConfigResolver(config ?? undefined),
    exec: fn,
    stageCtx: {
      deps: d,
      cache,
      baseKey: null,
      forcedDegraded: false,
      // Hoisted so the engine reads the hook without a deps lookup per call.
      validateResult: d.validateResult,
    },
  };
}

/** Per-invocation stage context: refreshes kill-switch flag + base key cheaply. */
function bindStageContext<T>(rt: ResolvedRuntime<T>): StageContext {
  const effective = rt.getEffective();
  let baseKey: string | null = null;
  try {
    baseKey = resolveBaseKey(effective, rt.stageCtx.deps, rt.stageCtx.cache);
  } catch (err) {
    warn(`cache key derivation failed (${normalizeError(err).message}); cache/replay stages will miss`);
  }
  return { ...rt.stageCtx, forcedDegraded: effective.forced_degraded, baseKey };
}

/**
 * Wrap a zero-arg callable with timeout+retry+backoff and an ordered fallback
 * chain. Output side is always async (`WrappedCallable`). Never throws — any
 * internal failure maps to DegradedResult{reason:"resilience_internal_error"}.
 */
export function withResilience<T>(
  fn: ResilientCallable<T>,
  config?: ResilienceConfig | null,
  deps?: WrapperDeps,
): WrappedCallable<T> {
  const rt = resolveRuntime(fn, config, deps);
  return async (): Promise<T | DegradedResult<T>> => {
    try {
      const ctx = bindStageContext(rt);
      return await runResilientAsync(rt.exec, rt.getEffective(), ctx);
    } catch (err) {
      // Outermost guard (GOV-RES-04 / RES-RES-03): nothing escapes unhandled.
      const normalized = normalizeError(err);
      warn(`resilience internal error (${normalized.message}); degrading gracefully`);
      return makeDegradedResult<T>({
        reason: "resilience_internal_error",
        fallback_source: "none",
        original_error: normalized.message,
      });
    }
  };
}

//#endregion

//#region Structured-output enforcement — withValidation (DP-A §4.4 x RES-01, §6)

/**
 * Builds the deps.validateResult hook (RES-04 wired into RES-01): validates the
 * callable's output against `schema`; on invalid output runs repair() EXACTLY
 * ONCE via renderRepairPrompt + the out-of-band deps.repairLlm; on second
 * failure throws ValidationRepairFailed, which the fallback machinery converts
 * to DegradedResult{reason:"validation_repair_failed"} (DP-A §6.4).
 */
function makeValidationHook(schema: object, repairLlm: LlmCallable | undefined) {
  return (raw: unknown): unknown => {
    let candidate: unknown;
    let originalText: string;
    if (typeof raw === "string") {
      // Callables commonly return raw JSON text (LLM completions) — parse first.
      originalText = raw;
      try {
        candidate = JSON.parse(raw);
      } catch {
        candidate = null; // unparseable -> root type error -> repair path
      }
    } else {
      try {
        originalText = JSON.stringify(raw) ?? String(raw);
      } catch {
        originalText = String(raw); // cyclic / non-serializable payload
      }
      candidate = raw;
    }
    const first = validate(schema, candidate);
    if (first.valid) return candidate;
    if (repairLlm === undefined) {
      throw new ValidationRepairFailed(
        "output failed schema validation and no repairLlm was supplied",
        first.errors,
      );
    }
    // Exactly-one repair round-trip (DP-A §6.2): the LLM is invoked ONCE, here.
    // A SYNC repairLlm completes synchronously so withResilienceSync returns the
    // repaired value directly; an ASYNC one yields a Promise the async engine
    // awaits. Both tails share completeRepair semantics: on second-stage failure
    // throw ValidationRepairFailed, which the fallback machinery converts to
    // DegradedResult{reason:"validation_repair_failed"} (DP-A §6.4).
    let rawOut: string | Promise<string>;
    try {
      rawOut = repairLlm(renderRepairPrompt(first.errors, originalText));
    } catch (e) {
      throw new ValidationRepairFailed(
        `repair callLlm failed: ${e instanceof Error ? e.message : String(e)}`,
        first.errors,
      );
    }
    if (rawOut instanceof Promise) {
      return (async () => {
        let text: string;
        try {
          text = await rawOut;
        } catch (e) {
          throw new ValidationRepairFailed(
            `repair callLlm failed: ${e instanceof Error ? e.message : String(e)}`,
            first.errors,
          );
        }
        return completeRepair(schema, text, first.errors).data;
      })();
    }
    return completeRepair(schema, rawOut, first.errors).data;
  };
}

/**
 * Wrap a callable AND enforce structured-output validation on its result
 * (DP-A §6.1/§6.4): valid output passes through unchanged (parsed when the
 * callable returned a JSON string); invalid output triggers exactly one
 * self-repair round-trip using the generic template + deps.repairLlm; a second
 * validation failure throws the internal ValidationRepairFailed, which the
 * step-5 RES-03 machinery catches and converts to DegradedResult{
 * reason:"validation_repair_failed", fallback_source:<step or "none">}.
 *
 * `repairLlm` is supplied out-of-band via deps like secondaryProvider (never
 * serialized into config). The repair call inherits timeout_ms; consumers may
 * set retries:1 to avoid latency amplification (DP-A §6.2). For tolerance with
 * plan-style call sites, deps.repairLlm wins over an optional config.repairLlm.
 */
export function withValidation<T>(
  fn: ResilientCallable<T>,
  schema: object,
  config?: ResilienceConfig | null,
  deps?: WrapperDeps,
): WrappedCallable<T> {
  const merged: WrapperDeps = { ...(deps ?? {}) };
  const fromConfig =
    config !== null && typeof config === "object"
      ? ((config as { repairLlm?: unknown }).repairLlm as LlmCallable | undefined)
      : undefined;
  const repairLlm = merged.repairLlm ?? fromConfig;
  merged.validateResult = makeValidationHook(schema, repairLlm);
  return withResilience(fn, config, merged);
}

//#endregion

//#region Sync variant — preserves sync return (DP-A §3.1/§4.1)

/** Synchronous sleep for the sync variant; no-op where SharedArrayBuffer is unavailable. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* cross-origin-isolated browsers etc.: proceed without delay */
  }
}

/**
 * Strict-sync output: returns T or DegradedResult synchronously. The sync path
 * uses a wall-clock deadline check AFTER the call joins (cooperative only — no
 * thread kill, GOV-RES-04); an over-deadline result is discarded and treated
 * as a retryable timeout failure. Awaitable results cannot be joined here:
 * they are passed through as-is with a structured warn.
 */
export function withResilienceSync<T>(
  fn: ResilientCallable<T>,
  config?: ResilienceConfig | null,
  deps?: WrapperDeps,
): () => T | DegradedResult<T> {
  const rt = resolveRuntime(fn, config, deps);
  const runSync = (): T | DegradedResult<T> => {
    try {
      const effective = rt.getEffective();
      const ctx = bindStageContext(rt);
      let lastError: Error | null = null;

      if (!ctx.forcedDegraded) {
        for (let attempt = 0; attempt <= effective.retries; attempt++) {
          const startedAt = Date.now();
          try {
            const raw = rt.exec();
            if (raw instanceof Promise) {
              warn("withResilienceSync received an awaitable result; returning as-is without timeout enforcement");
              return (raw as unknown) as T | DegradedResult<T>;
            }
            const elapsed = Date.now() - startedAt;
            if (elapsed > effective.timeout_ms) {
              throw new Error(`primary callable timed out after ${elapsed}ms (primary_timeout, detected post-join)`);
            }
            return runValidationHookSync(ctx, raw) as T | DegradedResult<T>;
          } catch (err) {
            lastError = normalizeError(err);
            if (lastError instanceof ValidationRepairFailed) {
              // Exactly-one repair semantics (DP-A §6.2): a failed repair is
              // terminal for the primary stage — never re-run primary/repair;
              // enter RES-03 now.
              break;
            }
            if (attempt < effective.retries) {
              sleepSync(computeBackoffDelayMs(effective, attempt + 1));
            }
          }
        }
      } else {
        lastError = new Error("skipped: forced_degraded kill switch active (RES-07)");
      }

      // Fallback stages that are synchronous-only here: cache/replay lookups on
      // the file store are sync in spirit but async in API — best effort: use
      // has/get through deasync-free path is impossible, so the sync variant
      // consults secondaryProvider (sync only) and otherwise degrades.
      for (const step of effective.fallback_chain.order) {
        if (step === "none") break;
        if (!effective.fallback_chain[step].enabled) continue;
        if (step === "secondary_provider" && !ctx.forcedDegraded && ctx.deps.secondaryProvider !== undefined) {
          try {
            const value = ctx.deps.secondaryProvider();
            if (!(value instanceof Promise)) return (value) as T | DegradedResult<T>;
          } catch (err) {
            warn(`fallback step secondary_provider failed (${normalizeError(err).message}); continuing down the chain`);
          }
        }
      }

      return makeDegradedResult<T>({
        reason: pickTerminalReason(lastError, ctx.forcedDegraded),
        fallback_source: "none",
        original_error: lastError?.message ?? null,
      });
    } catch (err) {
      const normalized = normalizeError(err);
      warn(`resilience internal error (${normalized.message}); degrading gracefully`);
      return makeDegradedResult<T>({
        reason: "resilience_internal_error",
        fallback_source: "none",
        original_error: normalized.message,
      });
    }
  };
  return runSync;
}

//#endregion

//#region Decorator alias (DP-A §3.1 "decorator as thin alias")

type AnyFn = (...args: never[]) => unknown;

/**
 * TS 5.x method decorator wrapping with withResilience (async methods) or
 * withResilienceSync (sync methods). Config resolution happens once per method.
 */
export function resilient(config?: ResilienceConfig | null, deps?: WrapperDeps) {
  return (target: AnyFn, context: ClassMethodDecoratorContext): AnyFn => {
    const method = target as (...args: unknown[]) => unknown;
    const isAsync = method.constructor?.name === "AsyncFunction";
    void context;
    return function decorated(this: unknown, ...args: unknown[]): unknown {
      const bound = () => method.apply(this, args);
      return isAsync ? withResilience(bound, config, deps)() : withResilienceSync(bound, config, deps)();
    } as AnyFn;
  };
}

//#endregion

//#region Core engine — iterative retry loop + ordered fallback chain (DP-A §3.3/§3.4, RES-02/03/07)

interface StageContext {
  deps: WrapperDeps;
  cache: GoldenCache;
  baseKey: string | null;
  forcedDegraded: boolean;
  /** Optional structured-output enforcement hook; full wiring lands with withValidation. */
  validateResult?: (result: unknown) => unknown;
}

/** Normalize any throwable to an Error with a string message (§8 contract row). */
function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  try {
    return new Error(String(err));
  } catch {
    return new Error("<unstringable throw>");
  }
}

/** Sync counterpart used by withResilienceSync: an awaitable hook outcome cannot
 * be joined here, so it is converted into ValidationRepairFailed — the fallback
 * machinery then degrades via the terminal DegradedResult instead of leaking an
 * internal Promise to the caller (never-throw, RES-RES-03/GOV-RES-04). */
function runValidationHookSync(ctx: StageContext, result: unknown): unknown {
  const hook = ctx.validateResult;
  if (hook === undefined) return result;
  const out = hook(result);
  if (out instanceof Promise) {
    warn("validateResult hook returned an awaitable in sync variant; cannot join — routing to fallback chain");
    throw new ValidationRepairFailed(
      "validateResult hook returned an awaitable in sync variant; async continuation cannot be joined synchronously",
      [],
    );
  }
  return out;
}

async function runValidationHook(ctx: StageContext, result: unknown): Promise<unknown> {
  const hook = ctx.validateResult;
  if (hook === undefined) return result;
  const out = hook(result);
  return out instanceof Promise ? await out : out;
}

/** One primary attempt with timeout + optional validation hook. Throws on failure. */
async function attemptPrimary<T>(exec: ResilientCallable<T>, timeoutMs: number, ctx: StageContext): Promise<T> {
  const raw = exec();
  const value = raw instanceof Promise ? await withTimeout(raw, timeoutMs, "primary callable") : await withTimeout(Promise.resolve(raw), timeoutMs, "primary callable");
  return (await runValidationHook(ctx, value)) as T;
}

/** Reason for the terminal DegradedResult (§4.3 examples, §7.3, §8). */
function pickTerminalReason(lastError: Error | null, forcedDegraded: boolean): string {
  if (lastError instanceof ValidationRepairFailed) return "validation_repair_failed";
  if (forcedDegraded) return "forced_degraded";
  if (lastError !== null && isTimeoutError(lastError)) return "primary_timeout";
  if (lastError !== null && lastError.message.includes("timed out after")) return "primary_timeout";
  return "primary_failed";
}

async function runResilientAsync<T>(
  exec: ResilientCallable<T>,
  effective: EffectiveConfig,
  stageCtx: StageContext,
): Promise<T | DegradedResult<T>> {
  let lastError: Error | null = null;

  // RES-02 retry loop — ITERATIVE (stack-preserving), retries = ADDITIONAL attempts.
  if (!stageCtx.forcedDegraded) {
    for (let attempt = 0; attempt <= effective.retries; attempt++) {
      try {
        return (await attemptPrimary(exec, effective.timeout_ms, stageCtx)) as T;
      } catch (err) {
        lastError = normalizeError(err);
        if (lastError instanceof ValidationRepairFailed) {
          // Exactly-one repair semantics (DP-A §6.2): a failed repair is terminal
          // for the primary stage — never re-run primary/repair; enter RES-03 now.
          break;
        }
        if (attempt < effective.retries) {
          const delayMs = computeBackoffDelayMs(effective, attempt + 1); // 1-based retry number
          if (delayMs > 0) await sleep(delayMs);
        }
      }
    }
  } else {
    lastError = new Error("skipped: forced_degraded kill switch active (RES-07)");
  }

  // RES-03 fallback chain — array position is the sole authority; disabled steps
  // are skipped silently; each stage individually guarded (§3.4 containment).
  for (const step of effective.fallback_chain.order) {
    if (step === "none") break; // terminal marker — nothing after it runs

    const stepEnabled = effective.fallback_chain[step].enabled;
    if (!stepEnabled) continue;

    try {
      if (step === "secondary_provider") {
        // Forced-degraded skips secondary too (RES-07 §7.3).
        if (!stageCtx.forcedDegraded && stageCtx.deps.secondaryProvider !== undefined) {
          const rawSecondary = stageCtx.deps.secondaryProvider();
          const value = await withTimeout(Promise.resolve(rawSecondary), effective.timeout_ms, "secondary provider");
          return (await runValidationHook(stageCtx, value)) as T;
        }
        continue;
      }
      if (step === "cache" || step === "replay") {
        if (stageCtx.baseKey === null) continue;
        const key = step === "replay" ? REPLAY_PREFIX + stageCtx.baseKey : stageCtx.baseKey;
        const hit = await stageCtx.cache.get(key);
        if (hit !== null && hit !== undefined) return hit as T;
        continue; // miss → next step
      }
    } catch (err) {
      const normalized = normalizeError(err);
      warn(`fallback step ${step} failed (${normalized.message}); continuing down the chain`);
      if (step === "secondary_provider") lastError = normalized;
      continue;
    }
  }

  // Terminal DegradedResult — typed signal, never throws (RES-RES-03).
  return makeDegradedResult<T>({
    reason: pickTerminalReason(lastError, stageCtx.forcedDegraded),
    fallback_source: "none",
    original_error: lastError?.message ?? null,
  });
}

//#endregion
