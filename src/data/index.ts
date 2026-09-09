// Requirement IDs: DATA-01, DATA-02, DATA-03, DATA-05, XCUT-06, XCUT-08
// src/data/index.ts — public import surface (DP-H §8.4). Consumers import ONLY these;
// deep imports into internals are lint-failed. Implementations land in later steps;
// export names stay stable from step 1.

export type {
  GenerateArgs,
  GenerateResult,
  SyntheticRecord,
  SyntheticDocument,
  OutputShape,
  DataGeneratorConfig,
  JSONSchema,
} from "./types.js";

export { generateRecords, generateDocuments } from "./generate.js";
export { watermarkBatch, WATERMARK_HEADER_TEXT } from "./watermark.js";
export type { WatermarkKind } from "./watermark.js";
