// Requirement IDs: DATA-01, DATA-REU-01
// src/data/prompt.ts — buildPrompt: generic prompt construction, domain injected
// at runtime only (DATA-REU-01, GOV-REU-02). DP-H §3.4.
//
// - Two separate skeletons (never merged): the structured variant embeds the
//   target JSON Schema verbatim for format adherence; the document variant
//   avoids schema language that degrades free-form quality (§3.4 rationale).
// - Templates are checked-in plain text files rendered at call time via the
//   tiny Mustache-style renderer (template.ts). Never YAML-embedded, never
//   code-generated at build time (§3.4).
// - Internal module: NOT re-exported from src/data/index.ts (deep-import rule,
//   §8.4 Public import surface).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./template.js";
import type { JSONSchema } from "./types.js";

const DATA_DIR = dirname(fileURLToPath(import.meta.url));
const STRUCTURED_TEMPLATE_PATH = join(DATA_DIR, "prompt.template.md");
const DOCUMENT_TEMPLATE_PATH = join(DATA_DIR, "prompt-document.template.md");

/** buildPrompt args — the runtime input tuple minus config/watermark/cache (§3.4 sketch). */
export interface BuildPromptArgs {
  domain: string; // free-text domain description, runtime only (DATA-REU-01)
  count: number; // batch size N
  schema?: JSONSchema; // present → structured path (variant a)
  docType?: string; // unstructured path document type (variant b)
  freeFormat?: string; // optional free-text format hint for variant b
}

/**
 * Render the LLM prompt for one generation call.
 * schema present → structured skeleton with {{schema_json}} pretty-printed;
 * otherwise → document skeleton with {{doc_type}} / {{freeFormat}}.
 */
export function buildPrompt(args: BuildPromptArgs): string {
  if (args.schema) {
    return renderTemplate(readFileSync(STRUCTURED_TEMPLATE_PATH, "utf8"), {
      domain: args.domain,
      count: String(args.count),
      schema_json: JSON.stringify(args.schema, null, 2),
    });
  }
  return renderTemplate(readFileSync(DOCUMENT_TEMPLATE_PATH, "utf8"), {
    domain: args.domain,
    count: String(args.count),
    doc_type: args.docType ?? args.freeFormat ?? "general document",
    freeFormat: args.freeFormat ?? "",
  });
}
