// Requirement IDs: DATA-01, DATA-02, DATA-03, DATA-05, DATA-REU-01, XCUT-08
// src/data/types.ts — TypeScript surface (DP-H §4.1 input contract, §4.2 output contract).
// Domain is runtime input only (DATA-REU-01); this file contains zero domain nouns.
// Validation of GenerateArgs happens via RES-04 against contracts/data-generator-input.schema.json.

/** Minimal structural type for caller-supplied JSON Schema (draft 2020-12 subset). */
export type JSONSchema = Record<string, unknown>;

/** OutputShape — target shape discriminator (DATA-02 paths A and B plus generic freeform). */
export type OutputShape =
  | { kind: "records"; schema: JSONSchema; count: number } // structured — DATA-02 path A
  | {
      kind: "documents";
      doc_type: "faq" | "policy" | "transcript" | "image_description" | "general";
      freeFormat?: string;
      count: number;
    }
  | { kind: "freeform"; freeFormat: string; count: number }; // unstructured free-text format

/** GenerateArgs — the sole entry point (DATA-01). Validated via RES-04 against contracts/data-generator-input.schema.json. */
export type GenerateArgs = {
  domain: string; // required, min 10 chars — free text, runtime (DATA-REU-01)
  shape: OutputShape; // required — schema OR doc type OR free-text format
  config?: DataGeneratorConfig; // optional — resolved via DP-H §6
  watermark?: boolean; // default true — must remain true in production (DATA-03)
  cache?: {
    // optional DATA-05 write-through to RES-05
    enabled?: boolean; // default false; if true, batch also cache.put
    key?: string; // explicit cache key; otherwise deriveKey(domain|shape|count)
    provider?: string; // for deriveKey traceability
    model?: string;
  };
};

/** ResilienceConfig re-used from the resilience module (RES-01) — imported, never duplicated. */
export type { ResilienceConfig } from "src/resilience";
import type { ResilienceConfig } from "src/resilience";

/** DataGeneratorConfig — data-specific knobs with safe defaults (DP-H §6.3, GOV-RES-02). */
export interface DataGeneratorConfig {
  model_profile?: string; // default: roles["data-generator"] from shared config/model-profiles.json
  role?: string; // default: "data-generator"
  provider?: string; // derived from profile; explicit override for tests (RES-REU-02)
  resilience?: ResilienceConfig; // per-call RES-01 overrides (timeout_ms, retries, fallback_chain)
  batch?: {
    maxCount?: number; // default 200 hard ceiling; per-call shape.count still enforced
    truncateFieldChars?: number; // default 4000 — per-field chars cap before LLM call
  };
  watermark?: {
    enabled?: boolean; // default true — disabling requires allowDisableWatermark flag (DATA-03)
    allowDisableWatermark?: boolean; // default false — only tests set true
    headerText?: string; // default "SYNTHETIC DEMO DATA — NOT REAL"
  };
  cache?: {
    enabled?: boolean; // default false
    dir?: string; // override GOLDEN_CACHE_DIR for this batch (RES-05)
  };
}

/** SyntheticRecord — DATA-03 marker is const true, injected by code post-validation. */
export type SyntheticRecord = object & { synthetic: true };

/** SyntheticDocument — document-style batch element (DATA-02 path B, DATA-03). */
export type SyntheticDocument = {
  synthetic: true; // DATA-03
  doc_type: string;
  title: string | null;
  content: string; // 2–6 paragraphs OR transcript turns delimited by \n
  metadata?: Record<string, unknown> | null;
  watermark_header?: string; // "SYNTHETIC DEMO DATA — NOT REAL" (DP-H §5.2)
};

/** DegradedResult re-used from the resilience module (RES-06) — imported, never duplicated. */
export type { DegradedResult } from "src/resilience";
import type { DegradedResult } from "src/resilience";

/** GenerateResult — ok-batch variant or RES-01 degraded fallback (DATA-RES-01). */
export type GenerateResult =
  | {
      ok: true;
      batch: Array<SyntheticRecord | SyntheticDocument>;
      bytes: number;
      count: number;
      synthetic: true;
    }
  | DegradedResult;

// Invariant: every element satisfies element.synthetic === true
// Invariant: batch is plain JSON-serializable Array<object>, no binary, no streaming envelope
