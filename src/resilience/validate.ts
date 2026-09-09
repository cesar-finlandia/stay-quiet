// Requirement IDs: RES-04, XCUT-08
// Structured-output validation + exactly-one self-repair round-trip — DP-A §4.4, §6.
// Single source: master_blueprint.md §4 #4. Error shape frozen at
// contracts/validation-error.schema.json. Synchronous, side-effect-free validation;
// wraps ajv internally but exposes only the plain JSON Schema surface (draft 2020-12).
// Domain-free (GOV-REU-02); zero imports from other chassis packages (RES-REU-01).

// Node builtins resolved lazily via node-compat (see cache/store.ts): the
// resilience barrel is imported by browser bundles (UI isDegraded path), so a
// static node:module import would crash them at module evaluation. ajv is
// likewise required on first use, not at import time.
import { nodeBuiltin } from "./node-compat.js";

// ajv ships CommonJS; loaded via createRequire so this ESM module resolves it
// at runtime. Typed through a minimal local surface (JSON Schema in, errors out).
let nodeRequireCache: ((id: string) => unknown) | null = null;
function nodeRequire(): (id: string) => unknown {
  if (!nodeRequireCache) {
    const mod = nodeBuiltin<typeof import("node:module")>("node:module");
    if (!mod) throw new Error("ajv validation requires a Node runtime (RES-04)");
    nodeRequireCache = mod.createRequire(import.meta.url);
  }
  return nodeRequireCache;
}
function requireDefault(modulePath: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = nodeRequire()(modulePath) as any;
  return mod && mod.__esModule ? mod.default : mod;
}

/** Minimal structural view of an ajv validate function (allErrors mode). */
interface CompiledValidator {
  (data: unknown): boolean;
  errors:
    | Array<{
        instancePath: string;
        message?: string;
        keyword: string;
      }>
    | null;
}
type Ajv2020Ctor = new (opts: Record<string, unknown>) => {
  compile(schema: object): CompiledValidator;
};
type AddFormatsFn = (ajv: object) => void;

let ajv2020Cache: Ajv2020Ctor | null = null;
function Ajv2020(): Ajv2020Ctor {
  return (ajv2020Cache ??= requireDefault("ajv/dist/2020") as Ajv2020Ctor);
}
let addFormatsCache: AddFormatsFn | null = null;
function addFormats(): AddFormatsFn {
  return (addFormatsCache ??= requireDefault("ajv-formats") as AddFormatsFn);
}

/** Frozen shape: contracts/validation-error.schema.json. */
export interface ValidationError {
  /** JSON Pointer-style location of the failing field ("/" = document root). */
  path: string;
  /** Human-readable failure description, rendered verbatim into the repair re-prompt. */
  message: string;
  /** Stable machine-readable error code (e.g. type, required, format, enum). */
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Internal signal for the wrapper (step 5): routes to the RES-03 fallback chain. */
export class ValidationRepairFailed extends Error {
  readonly reason = "validation_repair_failed";
  readonly errors: ValidationError[];

  constructor(message: string, errors: ValidationError[]) {
    super(message);
    this.name = "ValidationRepairFailed";
    this.errors = errors;
  }
}

/** Minimal callable contract accepted by repair(): sync or async, string -> string. */
export type LlmCallable = (input: string) => string | Promise<string>;

/** Compiled-validator memoization keyed by schema object identity (no global counters). */
const compiled = new WeakMap<object, CompiledValidator>();

function compile(schema: object): CompiledValidator {
  let fn = compiled.get(schema);
  if (!fn) {
    const ajv = new (Ajv2020())({ allErrors: true, strict: false });
    addFormats()(ajv);
    fn = ajv.compile(schema);
    compiled.set(schema, fn);
  }
  return fn;
}

/** Ajv instancePath ("" at root) -> JSON Pointer with non-empty root per contract. */
function normalizePointer(instancePath: string): string {
  return instancePath === "" || instancePath === "/" ? "/" : instancePath;
}

/**
 * validate(schema, data) -> {valid, errors} — synchronous and side-effect-free,
 * never calls an LLM (DP-A §6.1). Errors match contracts/validation-error.schema.json.
 */
export function validate(schema: object, data: unknown): ValidationResult {
  const fn = compile(schema);
  const ok = fn(data);
  if (ok) return { valid: true, errors: [] };
  const errors = ((fn.errors ?? []) as Array<{
    instancePath: string;
    message?: string;
    keyword: string;
  }>).map((e) => ({
    path: normalizePointer(e.instancePath),
    message: e.message ?? "validation failed",
    code: e.keyword === "required" ? "required" : e.keyword,
  }));
  return { valid: false, errors };
}

/** Shared tail of the repair round-trip (JSON parse -> re-validate). Raises
 * ValidationRepairFailed on any second-stage failure so async repair() and the
 * wrapper's sync-position hook share identical semantics (DP-A §6.2/§6.4). */
export function completeRepair(
  schema: object,
  raw: unknown,
  firstErrors: ValidationError[],
): { valid: boolean; data: unknown; errors: ValidationError[] } {
  if (typeof raw !== "string") {
    throw new ValidationRepairFailed("repair output was not a string", firstErrors);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    throw new ValidationRepairFailed("repair output was not valid JSON", firstErrors);
  }

  const second = validate(schema, parsed);
  if (!second.valid) {
    throw new ValidationRepairFailed("repaired output still fails validation", second.errors);
  }
  return { valid: true, data: parsed, errors: [] };
}

/**
 * Exactly-one self-repair round-trip (DP-A §6.2): one callLlm invocation with
 * rePrompt(errors) as input, parse as JSON, re-validate, return. On second
 * failure throws ValidationRepairFailed — the wrapper catches it and routes to
 * the RES-03 fallback chain with reason "validation_repair_failed". No retry
 * loop of its own; no global state (counter hygiene).
 */
export async function repair(
  schema: object,
  data: unknown,
  rePrompt: (errors: ValidationError[]) => string,
  callLlm: LlmCallable,
): Promise<{ valid: boolean; data: unknown; errors: ValidationError[] }> {
  const first = validate(schema, data);
  if (first.valid) return { valid: true, data, errors: [] };

  let raw: string;
  try {
    raw = await callLlm(rePrompt(first.errors));
  } catch (e) {
    throw new ValidationRepairFailed(
      `repair callLlm failed: ${e instanceof Error ? e.message : String(e)}`,
      first.errors,
    );
  }

  return completeRepair(schema, raw, first.errors);
}

const REPAIR_PROMPT_TEMPLATE = `The previous response failed schema validation. Fix ONLY the validation errors listed below and return the corrected output as valid JSON conforming to the provided schema. Do not add commentary, do not invent fields absent from the schema, do not change fields that already passed validation.

Validation errors:
{{#each errors}}
{{error_lines}}
{{/each}}

Original output (for reference):
{{original_output_truncated_4k}}

Return ONLY the corrected JSON object.`;

export const REPAIR_OUTPUT_TRUNCATE_CHARS = 4000;

/**
 * Renders the generic re-prompt template (DP-A §6.3, checked in verbatim at
 * src/resilience/repair-prompt.template.md) with the given errors plus the
 * original output truncated at 4k chars. Consumers never author prompts.
 */
export function renderRepairPrompt(
  errors: ValidationError[],
  originalOutput: string,
): string {
  const errorLines = errors
    .map((e) => `- path: ${e.path} | code: ${e.code} | message: ${e.message}`)
    .join("\n");
  const truncated =
    originalOutput.length > REPAIR_OUTPUT_TRUNCATE_CHARS
      ? originalOutput.slice(0, REPAIR_OUTPUT_TRUNCATE_CHARS)
      : originalOutput;
  return REPAIR_PROMPT_TEMPLATE.replaceAll("{{error_lines}}", errorLines).replaceAll(
    "{{original_output_truncated_4k}}",
    truncated,
  );
}
