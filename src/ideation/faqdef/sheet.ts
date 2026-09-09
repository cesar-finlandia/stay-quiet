// Requirement IDs: FAQDEF-01..03, FAQDEF-RES-02, XCUT-08 | Owned by M14 step 4 (DP-D2b §5.2/§6.2)
// Q&A sheet types + renderers. docs/qa/qa-sheet.json is the machine artifact
// (RES-04 validated against contracts/faqdef-sheet.schema.json); qa-sheet.md is
// the human defense sheet. Every write is atomic (tmp + rename). Any entry
// whose grounding is not_stated renders with a "WARNING: Unverified —" prefix
// so a reviewer cannot miss it before the live session.

import { validate } from "../../resilience/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomically } from "../demodrive/output.js";

const SHEET_SCHEMA_PATH = join("contracts", "faqdef-sheet.schema.json");

export type FaqdefAxis =
  | "presentation"
  | "business_value"
  | "application_of_technology"
  | "originality";

export interface FaqdefSheetEntry {
  id: string;
  question: string;
  tags: string[];
  draft_answer: string;
  citations: string[];
  source_grounding: "grounded" | "partial" | "not_stated";
}

export interface FaqdefSheet {
  version: "1.0.0";
  generated_at: string;
  question_count: number;
  questions: FaqdefSheetEntry[];
}

/** RES-04 gate — returns error list; empty = valid. */
export function validateSheet(sheet: unknown): { valid: boolean; errors: Array<{ path: string; message: string; code: string }> } {
  const schema = JSON.parse(readFileSync(SHEET_SCHEMA_PATH, "utf8")) as object;
  const res = validate(schema, sheet);
  return { valid: res.valid, errors: res.errors };
}

/** Human Markdown rendering of the sheet (docs/qa/qa-sheet.md). */
export function renderSheetMarkdown(sheet: FaqdefSheet): string {
  const lines: string[] = [];
  lines.push(`# Judge Q&A Defense Sheet`);
  lines.push("");
  lines.push(`Generated ${sheet.generated_at} · ${sheet.question_count} questions · grounded in winning_project_plan.md / manifest / PROV disclosure only.`);
  lines.push("");
  for (const q of sheet.questions) {
    const warning =
      q.source_grounding === "not_stated" ? `WARNING: Unverified — ` : "";
    lines.push(`## ${q.id} [${q.tags.join(" + ")}] — grounded: ${q.source_grounding}`);
    lines.push("");
    lines.push(`Q: ${q.question}`);
    lines.push("");
    lines.push(`${warning}A: ${q.draft_answer}`);
    if (q.citations.length > 0) {
      lines.push("");
      lines.push(`Sources: ${q.citations.join(" · ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
