// Requirement IDs: SUBMIT-01, SUBMIT-RES-01, GOV-REU-03, XCUT-08
// SUBMIT-01 mechanical field extractor — TypeScript twin of
// src/provenance/submit/extract.py (DP-J §5.1). No LLM anywhere: every value
// is verbatim-copied from winning_project_plan.md (frontmatter or frozen body
// headings) and assembly.manifest.json, never invented (SUBMIT-REU-01).
//
// Imports limited to src/resilience/*, contracts/* and Node stdlib
// (GOV-REU-03). No network anywhere.

import { join } from "node:path";

import { REPO_ROOT } from "../provo/validate.js";

export const WINNING_PLAN_FRONTMATTER_SCHEMA_PATH = join(
  REPO_ROOT,
  "contracts",
  "winning-plan-frontmatter.schema.json",
);

/** SUBMIT-RES-01 exact gap marker (DP-J §5.5). */
export const GAP_MARKER = "> — not stated in winning_project_plan.md — confirm manually";

/** Frozen body headings (master_blueprint §4 #7 / DP-K §7). */
export const FROZEN_HEADINGS = [
  "Executive Pitch",
  "Problem Framing",
  "AI Solution",
  "Why Now",
  "Target Persona",
  "Business Value",
  "Architecture",
  "Suggested Module Emphasis",
] as const;

export const TAGLINE_MAX_CHARS = 120;

export interface ExtractedFields {
  tagline: string;
  target_user: string;
  why_ai: string;
  tech_stack: string[];
  not_extracted_fields: string[];
  sections: Record<string, string>;
  warnings: string[];
}

/** Split a winning_project_plan.md document into (raw YAML|null, body).
 * Frontmatter is only recognized when the very first line is `---` and a
 * closing `---` line follows; otherwise the whole text is body. */
export function splitFrontmatter(planText: string): [string | null, string] {
  const lines = planText.split(/\r?\n/);
  if (lines.length === 0 || (lines[0]?.trim() ?? "") !== "---") return [null, planText];
  for (let idx = 1; idx < lines.length; idx++) {
    if ((lines[idx]?.trim() ?? "") === "---") {
      return [lines.slice(1, idx).join("\n"), lines.slice(idx + 1).join("\n")];
    }
  }
  return [null, planText];
}

function unquote(value: string): string {
  const v = value.trim();
  const first = v.charAt(0);
  if (v.length >= 2 && first === v.charAt(v.length - 1) && (first === "'" || first === '"')) {
    const inner = v.slice(1, -1);
    // Undo the two escapes YAML double-quote style supports that matter
    // for plan files: \" and \\ (keep everything else verbatim).
    return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  return v;
}

/** Minimal YAML subset parser for the frozen frontmatter keys — plain
 * `key: value` scalars (optionally quoted) plus inline `[a, b]` arrays.
 * Comments and blank lines are skipped. Unknown keys are kept so RES-04 can
 * flag them via additionalProperties:false. */
export function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(stripped);
    if (!match || !match[1]) continue;
    const key: string = match[1];
    const value = (match[2] ?? "").trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item))
        .filter((item) => item.length > 0);
    } else {
      result[key] = unquote(value);
    }
  }
  return result;
}

/** Split the body by frozen heading regex `^##\\s+<heading>\\s*$`.
 * Returns heading -> section text (everything up to the next `## ` heading;
 * trimmed). Unfrozen headings are ignored. */
export function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && match[1]) {
      if (current !== null) sections[current] = buffer.join("\n").trim();
      const name: string = match[1];
      current = (FROZEN_HEADINGS as readonly string[]).includes(name) ? name : null;
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  if (current !== null) sections[current] = buffer.join("\n").trim();
  return sections;
}

/** First sentence of `text` truncated to max_chars (DP-J §5.1 tagline
 * fallback). Sentence boundary = `.`, `!` or `?` followed by whitespace. */
export function firstSentence(text: string, maxChars: number = TAGLINE_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const match = /^(.+?[.!?])(?:\s|$)/.exec(collapsed);
  return (match?.[1] ?? collapsed).slice(0, maxChars);
}

// Explicit stack tag: capitalized token(s), optionally version-y chars
// (`Next.js`, `Node.js`, `C++`), max two words, <= 30 chars.
const TAG_ITEM_RE = /^[A-Z][A-Za-z0-9.+#]*(?: [A-Z][A-Za-z0-9.+#]*)?$/;
const TAG_LINE_PREFIX_RE = /(?:^|[\s;*])(?:stack|tech stack|tags|built with)\s*:\s*([^\n]+)$/i;

/** Extract explicit comma-separated stack tags from one section's text
 * (DP-J §5.1: "comma-separated tags like `React`, `OpenAI`, `Vercel`").
 * Mechanical, reproducible rule — a line yields tags when either
 *   (a) it contains a `Stack:` / `Tech stack:` / `Tags:` / `Built with:`
 *       marker and every comma-separated item after it matches TAG_ITEM_RE,
 *       or
 *   (b) the WHOLE line is a run of >= 2 comma-separated TAG_ITEM_RE tokens.
 * Prose sentences never qualify under (b), so nothing is invented. */
export function extractTechTags(sectionText: string): string[] {
  const tags: string[] = [];
  for (const rawLine of sectionText.split(/\r?\n/)) {
    const stripped = rawLine.trim();
    if (!stripped) continue;
    const prefixed = TAG_LINE_PREFIX_RE.exec(stripped);
    const candidate = prefixed?.[1] ? prefixed[1].trim() : stripped;
    if (!prefixed && candidate.split(",")[0]?.split(" ")[0]?.includes(":")) {
      continue; // some other `key: ...` line — never treat as tag run
    }
    const items = candidate.split(",").map((item) => item.trim().replace(/\.$/, ""));
    if (items.length < 2) continue;
    if (items.every((item) => item.length > 0 && item.length <= 30 && TAG_ITEM_RE.test(item))) {
      tags.push(...items);
    }
  }
  return tags;
}

function bulletValue(sectionText: string, key: string): string {
  for (const line of sectionText.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*[-*]\\s*${key}\\s*:\\s*(.+?)\\s*$`).exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped) return stripped;
  }
  return "";
}

export interface ExtractFieldsOptions {
  /** Optional {section name -> text} scanned for explicit tags; omitted
   * scans the plan's own `## Architecture` / `## Suggested Module Emphasis`. */
  techTagSections?: Record<string, string>;
  /** Optional config provider_labels map (e.g. openai -> OpenAI). */
  providerLabels?: Record<string, string>;
  /** RES-04-validated frontmatter dict (None/ignored when invalid). */
  frontmatter?: Record<string, unknown> | null;
  frontmatterValid?: boolean;
}

/** Map canonical fields per DP-J §5.1. Pure: no FS, no LLM, no clock.
 * Gapped fields carry empty values and are listed in not_extracted_fields
 * in canonical order (SUBMIT-RES-01). */
export function extractFields(
  planText: string,
  manifestProviders: string[],
  options: ExtractFieldsOptions = {},
): ExtractedFields {
  const {
    techTagSections,
    providerLabels,
    frontmatter,
    frontmatterValid = false,
  } = options;

  const [_rawFrontmatter, body] = splitFrontmatter(planText);
  const sections = splitSections(body);

  const fm = frontmatter && frontmatterValid ? frontmatter : null;
  const title = typeof fm?.title === "string" ? fm.title.trim() : "";
  const persona = typeof fm?.persona === "string" ? fm.persona.trim() : "";

  // --- tagline: frontmatter.title | Executive Pitch first sentence ------
  const tagline = title || firstSentence(sections["Executive Pitch"] ?? "");

  // --- target_user: persona | Business Value.specific_user | Target Persona
  const targetUser =
    persona ||
    bulletValue(sections["Business Value"] ?? "", "specific_user") ||
    firstNonEmptyLine(sections["Target Persona"] ?? "");

  // --- why_ai: Why Now one-liner | Business Value.why_ai | first sentence
  const whyNow = sections["Why Now"] ?? "";
  const whyAi =
    firstNonEmptyLine(whyNow) ||
    bulletValue(sections["Business Value"] ?? "", "why_ai") ||
    (whyNow ? firstSentence(whyNow, 400) : "");

  // --- tech_stack: union(manifest providers, explicit section tags) -----
  const labels = providerLabels ?? {};
  const tagSources =
    techTagSections ??
    Object.fromEntries(
      ["Architecture", "Suggested Module Emphasis"].map((name) => [name, sections[name] ?? ""]),
    );
  const seen = new Map<string, string>(); // lowercase -> original casing
  for (const provider of manifestProviders) {
    const name = String(provider).trim();
    if (!name) continue;
    if (!seen.has(name.toLowerCase())) {
      seen.set(name.toLowerCase(), labels[name.toLowerCase()] ?? name);
    }
  }
  for (const sectionName of ["Architecture", "Suggested Module Emphasis"]) {
    for (const tag of extractTechTags(tagSources[sectionName] ?? "")) {
      if (!seen.has(tag.toLowerCase())) {
        seen.set(tag.toLowerCase(), labels[tag.toLowerCase()] ?? tag);
      }
    }
  }
  const techStack = [...seen.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const fields: Record<string, unknown> = {
    tagline: tagline.trim(),
    target_user: targetUser.trim(),
    why_ai: whyAi.trim(),
    tech_stack: techStack,
  };
  const canonical = ["tagline", "target_user", "why_ai", "tech_stack"] as const;
  const notExtracted = canonical.filter((name) => {
    const value = fields[name];
    return typeof value === "string" ? !value : (value as string[]).length === 0;
  });

  return {
    tagline: fields.tagline as string,
    target_user: fields.target_user as string,
    why_ai: fields.why_ai as string,
    tech_stack: techStack,
    not_extracted_fields: notExtracted,
    sections,
    warnings: [],
  };
}
