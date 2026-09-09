// Requirement IDs: DATA-01, DATA-02, DATA-04, DATA-05, DATA-RES-01
// Core generation pipeline — DP-H §3.2/3.3, §5.1, §7.1/7.2. Both paths share
// prompt construction + the RES-01 wrapper and diverge only at prompt
// instruction and post-validation (strict schema vs structural check).
//
// Guarantees (DATA-RES-01, GOV-RES-04 / RES-RES-03):
// - Input self-validated via RES-04 BEFORE any LLM call; invalid input →
//   DegradedResult{reason:"invalid_input"} with zero provider traffic.
// - Provider call wrapped in withResilience (timeout/retry/fallback); a
//   DegradedResult from the wrapper is surfaced unchanged, never thrown.
// - Validation engine imported ONLY from src/resilience (DATA-04) — no
//   schema-validation library is ever instantiated in src/data (CI-greppable).
// - repair() runs EXACTLY ONCE per generation (DP-A §6.2) → total LLM calls ≤ 2.
// - No throw escapes either entry point; outer guard maps any escape to a
//   DegradedResult with fallback_source "none".
// - Watermark injected by code post-validation, pre-write (DATA-03, §5.2).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, repair, renderRepairPrompt } from "src/resilience";
import { withResilience, isDegradedResult, makeDegradedResult, createGoldenCache } from "src/resilience";
import type { ResilienceConfig, ValidationError, DegradedResult } from "src/resilience";
import type { GenerateArgs, GenerateResult, JSONSchema, SyntheticDocument, SyntheticRecord } from "./types.js";
import { resolveConfig, resolveModelProfile } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { callProvider } from "./provider.js";
import { watermarkBatch } from "./watermark.js";
import { writeBatch } from "./writer.js";
import type { SinkOptions, WriterKind } from "./writer.js";
import type { WatermarkKind } from "./watermark.js";

/** §7.1 baseline for one generation call (mirrors defaults.json; resolveConfig layers overrides on top). */
const DATA_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RESILIENCE: ResilienceConfig = {
  timeout_ms: 30000,
  retries: 2,
  backoff: { policy: "exponential", base_ms: 500, factor: 2.0, max_ms: 5000, jitter: true },
  fallback_chain: { order: ["replay", "cache", "none"] },
  cache_key_strategy: "auto",
};

//#region Internal helpers

//#region Contract loading with $ref inlining (RES-04 validate resolves no external refs)

type JsonObj = Record<string, unknown>;

/** Maps frozen contract ids to their checked-in single-source files. */
const CONTRACTS_DIR = join(DATA_DIR, "..", "..", "contracts");
const CONTRACT_BY_ID = new Map<string, string>([
  ["https://chassis/contracts/data-generator-input.schema.json", "data-generator-input.schema.json"],
  ["https://chassis/contracts/data-generator-config.schema.json", "data-generator-config.schema.json"],
  ["https://chassis/contracts/resilience-config.schema.json", "resilience-config.schema.json"],
]);

const contractCache = new Map<string, object>();

function loadContractById(id: string): object | null {
  const cached = contractCache.get(id);
  if (cached) return cached;
  const file = CONTRACT_BY_ID.get(id);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(CONTRACTS_DIR, file), "utf8")) as object;
    contractCache.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Recursively swaps https://chassis/contract $refs with the loaded contract bodies. */
function inlineContractRefs(node: unknown, depth = 0): unknown {
  if (depth > 16 || Array.isArray(node)) {
    return Array.isArray(node) ? node.map((n) => inlineContractRefs(n, depth + 1)) : node;
  }
  if (typeof node !== "object" || node === null) return node;
  const ref = (node as JsonObj)["$ref"];
  if (typeof ref === "string" && CONTRACT_BY_ID.has(ref)) {
    const resolved = loadContractById(ref);
    return resolved ? inlineContractRefs(resolved, depth + 1) : node;
  }
  const out: JsonObj = {};
  for (const [k, v] of Object.entries(node as JsonObj)) out[k] = inlineContractRefs(v, depth + 1);
  return out;
}

let inputSchemaCache: object | null = null;

/** Input contract with all external $refs inlined — ready for RES-04 validate(). */
function loadInputSchema(): object | null {
  if (!inputSchemaCache) {
    const raw = loadContractById("https://chassis/contracts/data-generator-input.schema.json");
    if (!raw) return null;
    inputSchemaCache = inlineContractRefs(raw) as object;
  }
  return inputSchemaCache;
}

//#endregion

/** Duck-typed check for src/resilience's ValidationRepairFailed (class not re-exported from the RES index; reason field is its stable marker). */
function isValidationRepairFailed(e: unknown): boolean {
  return e instanceof Error && (e as { reason?: string }).reason === "validation_repair_failed";
}

/** Effective resilience for one call: resolved config + RES-07 forced-degraded kill switch. */
function effectiveResilience(args: GenerateArgs): ResilienceConfig {
  const cfg = resolveConfig(args.config);
  const eff: ResilienceConfig = structuredClone(cfg.resilience) ?? structuredClone(DEFAULT_RESILIENCE);
  // Plan §7.1 names DATA_FORCED_DEGRADED=1 as an alias of the RES-07 kill switch;
  // the RES layer natively honors RES_FORCED_DEGRADED / config.forced_degraded.
  if (process.env.DATA_FORCED_DEGRADED === "1" || eff.forced_degraded === true) {
    eff.forced_degraded = true;
  }
  return eff;
}

/** DATA-03 gate: watermark:false is blocked unless allowDisableWatermark:true (test-only). */
function watermarkDecision(args: GenerateArgs): { apply: boolean; headerText: string } {
  const cfg = resolveConfig(args.config);
  const requested = args.watermark !== false;
  if (requested) return { apply: true, headerText: cfg.watermark.headerText };
  if (cfg.watermark.allowDisableWatermark === true) return { apply: false, headerText: "" };
  console.warn("warn: watermark disabled — not allowed in production per DATA-03");
  return { apply: true, headerText: cfg.watermark.headerText };
}

/** Raw provider text → parsed JSON. Parse failure becomes a sentinel object that FAILS validation, entering repair (§5.1). */
function parseRaw(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (e) {
    return { __parse_error: String(e), rawText: rawText.slice(0, 4000) };
  }
}

/** Cache-fallback hits arrive already-parsed (§7.2); provider text still needs JSON.parse. */
function parseOrSelf(raw: unknown): unknown {
  return typeof raw === "string" ? parseRaw(raw) : raw;
}

/**
 * One RES-01-wrapped provider invocation. Returns raw model text on success —
 * or, when the wrapper's `cache` fallback step hits (offline path §7.2), the
 * ALREADY-PARSED cached batch object; DegradedResult surfaces unchanged.
 * Key material mirrors writer.ts derivation exactly so write-through entries
 * are readable offline: deriveKey({provider,model,prompt:{domain,shape}}) or
 * deriveKey({explicitKey}) when args.cache.key is set. Cache root honors
 * config.cache.dir (RES-05); no key material → cache/replay simply miss.
 */
async function invokeProvider(prompt: string, args: GenerateArgs): Promise<unknown> {
  const modelProfile = resolveModelProfile(args.config);
  const cfg = resolveConfig(args.config);
  const eff = effectiveResilience(args);
  const rootDir = typeof cfg.cache.dir === "string" && cfg.cache.dir.trim() ? cfg.cache.dir.trim() : undefined;
  const deps: {
    cache?: ReturnType<typeof createGoldenCache>;
    cacheKey?: string;
    keyInput?: { provider: string; model: string; prompt: unknown };
  } = {};
  if (rootDir !== undefined || args.cache?.enabled === true) {
    const cache = createGoldenCache(rootDir);
    if (typeof args.cache?.key === "string" && args.cache.key.trim()) {
      deps.cache = cache;
      deps.cacheKey = cache.deriveKey({ explicitKey: args.cache.key.trim() });
    } else {
      deps.cache = cache;
      deps.keyInput = {
        provider: args.cache?.provider ?? args.config?.provider ?? cfg.provider ?? "unknown",
        model: args.cache?.model ?? cfg.model ?? "unknown",
        prompt: { domain: args.domain, shape: args.shape },
      };
    }
  }
  const wrapped = withResilience(() => callProvider(prompt, modelProfile), eff, deps);
  return await wrapped();
}

/** validate + EXACTLY-ONE repair round-trip (DP-A §6.2). allowRepair=false (cache-served
 *  batches — no LLM budget offline) skips the repair leg: invalid → degraded directly. */
async function validateOrRepair(
  schema: object,
  parsed: unknown,
  args: GenerateArgs,
  allowRepair = true,
): Promise<{ ok: true; data: unknown } | { ok: false; degraded: ReturnType<typeof makeDegradedResult> }> {
  const first = validate(schema, parsed);
  if (first.valid) return { ok: true, data: parsed };
  if (!allowRepair) {
    return {
      ok: false,
      degraded: makeDegradedResult({
        reason: "validation_repair_failed",
        fallback_source: "cache",
        original_error: "cached batch failed re-validation; repair unavailable offline",
      }),
    };
  }
  const renderFor = (errors: ValidationError[]): string =>
    renderRepairPrompt(errors, JSON.stringify(parsed ?? null));
  try {
    const repaired = await repair(
      schema,
      parsed,
      renderFor,
      async (prompt: string) => callProvider(prompt, resolveModelProfile(args.config)),
    );
    return { ok: true, data: repaired.data }; // repair re-validates internally
  } catch (e) {
    if (isValidationRepairFailed(e)) {
      return {
        ok: false,
        degraded: makeDegradedResult({
          reason: "validation_repair_failed",
          fallback_source: "none",
          original_error: e instanceof Error ? e.message : String(e),
        }),
      };
    }
    throw e; // outer guard maps non-repair escapes
  }
}

//#endregion

//#region DATA-02 path A — structured records

/**
 * generateRecords — schema-conforming record batch (DP-H §3.2 path A, §7.1).
 * Never throws; returns GenerateResult (ok batch or DegradedResult).
 */
export async function generateRecords(args: GenerateArgs, sink?: SinkOptions): Promise<GenerateResult> {
  try {
    // 1) Entry self-validation against the frozen input contract — NO LLM call on failure.
    const inputSchema = loadInputSchema();
    if (!inputSchema) {
      return makeDegradedResult({ reason: "resilience_internal_error", fallback_source: "none", original_error: "contracts/data-generator-input.schema.json unreadable" });
    }
    const inputCheck = validate(inputSchema, args);
    if (!inputCheck.valid) {
      return makeDegradedResult({ reason: "invalid_input", fallback_source: "none", original_error: inputCheck.errors.map((e) => `${e.path}: ${e.message}`).join("; ") });
    }
    if (args.shape.kind !== "records") {
      return makeDegradedResult({ reason: "invalid_input", fallback_source: "none", original_error: "generateRecords requires shape.kind === 'records'" });
    }

    const cfg = resolveConfig(args.config);
    // Hard ceiling from §6.3 — per-call count enforced against config.batch.maxCount.
    const count = Math.max(1, Math.min(args.shape.count, cfg.batch.maxCount));
    const callerBatchSchema = {
      type: "array",
      items: args.shape.schema,
      minItems: count,
      maxItems: count,
    };

    // 2) Prompt (generic template, domain at runtime only) + RES-01-wrapped provider call.
    const prompt = buildPrompt({ domain: args.domain, count, schema: args.shape.schema });
    const raw = await invokeProvider(prompt, args);
    if (isDegradedResult(raw)) return raw; // surface unchanged — never throw (DATA-RES-01)

    // 3) Parse → validate → repair EXACTLY ONCE → watermark (§5.1 sequence).
    // A non-string result is the wrapper's cache-fallback hit — already JSON;
    // re-validate WITHOUT a repair round-trip (no LLM available offline).
    const parsedOutcome = await validateOrRepair(
      callerBatchSchema,
      typeof raw === "string" ? parseRaw(raw) : raw,
      args,
      typeof raw === "string",
    );
    if (!parsedOutcome.ok) return parsedOutcome.degraded;
    const batch = parsedOutcome.data as unknown[];
    // 4) Watermark by code, post-validation, pre-write (DATA-03).
    const wm = watermarkDecision(args);
    if (!wm.apply) {
      // Test-only disable honored — elements keep their validated shape unmarked.
    } else {
      watermarkBatch(batch, "records", wm.headerText);
    }

    // 5) DATA-05 dual-sink — atomic fixture write + optional RES-05 write-through.
    return await finishOk(batch, args, "records", sink);
  } catch (e) {
    // RES-RES-03 defense-in-depth — no throw escapes (GOV-RES-04).
    return makeDegradedResult({ reason: "resilience_internal_error", fallback_source: "none", original_error: e instanceof Error ? e.message : String(e) });
  }
}

//#endregion

//#region DATA-02 path B — documents / freeform

/**
 * generateDocuments — unstructured document batch for RAG seeding / rehearsal
 * (DP-H §3.2 path B). Schema-less inputs get the lightweight structural check;
 * a caller schema (records-style shape) would take the validate+one-repair path.
 * Never throws.
 */
export async function generateDocuments(args: GenerateArgs, sink?: SinkOptions): Promise<GenerateResult> {
  try {
    // 1) Entry self-validation — NO LLM call on failure.
    const inputSchema = loadInputSchema();
    if (!inputSchema) {
      return makeDegradedResult({ reason: "resilience_internal_error", fallback_source: "none", original_error: "contracts/data-generator-input.schema.json unreadable" });
    }
    const inputCheck = validate(inputSchema, args);
    if (!inputCheck.valid) {
      return makeDegradedResult({ reason: "invalid_input", fallback_source: "none", original_error: inputCheck.errors.map((e) => `${e.path}: ${e.message}`).join("; ") });
    }
    if (args.shape.kind !== "documents" && args.shape.kind !== "freeform") {
      return makeDegradedResult({ reason: "invalid_input", fallback_source: "none", original_error: "generateDocuments requires shape.kind 'documents' or 'freeform'" });
    }

    const cfg = resolveConfig(args.config);
    const count = Math.max(1, Math.min(args.shape.count, cfg.batch.maxCount));
    const docType = args.shape.kind === "documents" ? args.shape.doc_type : undefined;
    const freeFormat = args.shape.kind === "documents" ? args.shape.freeFormat : args.shape.freeFormat;

    // 2) Shared prompt construction (document skeleton) + RES-01 wrap.
    const prompt = buildPrompt({ domain: args.domain, count, docType, freeFormat });
    const raw = await invokeProvider(prompt, args);
    if (isDegradedResult(raw)) return raw;

    let parsed = parseOrSelf(raw);

    // 3) Lightweight structural check for schema-less documents (§5.1 call-site table).
    // A cache-served batch arrives already-parsed and previously watermarked.
    const structuralOk =
      Array.isArray(parsed) && parsed.every((d) => typeof (d as { content?: unknown })?.content === "string");
    if (!structuralOk) {
      return makeDegradedResult({ reason: "document_structural_check_failed", fallback_source: "none", original_error: null });
    }
    // Normalize each element to the SyntheticDocument shape before watermarking.
    parsed = (parsed as unknown[]).map((d, i) => normalizeDocument(d as Record<string, unknown>, docType ?? "general", i));
    // 4) Watermark: synthetic:true + header INSIDE content + watermark_header field.
    const wm = watermarkDecision(args);
    if (wm.apply) watermarkBatch(parsed as unknown[], "documents", wm.headerText);

    // 5) DATA-05 dual-sink — filename kind mirrors shape.kind (documents|freeform).
    return await finishOk(parsed as unknown[], args, args.shape.kind, sink);
  } catch (e) {
    return makeDegradedResult({ reason: "resilience_internal_error", fallback_source: "none", original_error: e instanceof Error ? e.message : String(e) });
  }
}

function normalizeDocument(d: Record<string, unknown>, docType: string, index: number): Record<string, unknown> {
  return {
    doc_type: typeof d["doc_type"] === "string" ? d["doc_type"] : docType,
    title: typeof d["title"] === "string" ? d["title"] : null,
    content: d["content"],
    metadata: (typeof d["metadata"] === "object" && d["metadata"] !== null) || d["metadata"] === null ? d["metadata"] : { source: "synthetic-demo-generator", index },
  };
}

/**
 * Ok-variant builder shared by both paths — runs the DATA-05 dual-sink
 * (atomic file write + optional RES-05 write-through) on the SAME watermarked
 * batch, then reports disk bytes in GenerateResult (§4.5). Writer failures are
 * warned and swallowed: an ok batch never becomes a crash (§7.2).
 */
async function finishOk(
  batch: unknown[],
  args: GenerateArgs,
  kind: WriterKind,
  sink?: SinkOptions,
): Promise<GenerateResult> {
  let bytes = Buffer.byteLength(JSON.stringify(batch)); // in-memory fallback when no file written
  try {
    const written = await writeBatch(batch, {
      kind,
      domain: args.domain,
      count: batch.length,
      outDir: sink?.outDir,
      writeFile: sink?.writeFile,
      cache: args.cache,
      shape: args.shape,
      config: args.config,
    });
    if (written > 0) bytes = written;
  } catch (e) {
    console.warn(`[data] warn: output stage failed (${e instanceof Error ? e.message : String(e)}); returning in-memory batch`);
  }
  return {
    ok: true,
    batch: batch as Array<SyntheticRecord | SyntheticDocument>,
    bytes,
    count: batch.length,
    synthetic: true,
  };
}

//#endregion
