// Requirement IDs: SUBMIT-04, SUBMIT-03, SUBMIT-RES-01, GOV-RES-02, XCUT-08
// SUBMIT-04 submission-doc assembler — TypeScript twin of
// src/provenance/submit/format.py (DP-J §5.4). `formatSubmission` is a PURE
// function of plan text + manifest providers + disclosure text + event
// profile + config (+ injected clock): re-running after editing any input
// reproduces the doc modulo generated_at. No side effects beyond the
// caller's atomic write of the returned markdown.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../../resilience/index.js";
import { REPO_ROOT } from "../provo/validate.js";
import { GAP_MARKER, extractFields } from "./extract.js";
import type { ExtractFieldsOptions } from "./extract.js";
import { embedDisclosure } from "./embed.js";
import { resolveLabels } from "./labels.js";
import type { CanonicalField } from "./labels.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SUBMIT_CONFIG_PATH = join(HERE, "..", "config", "submit.json");
export const SUBMIT_TEMPLATE_PATH = join(HERE, "templates", "submission.template.md");
export const SUBMIT_CONFIG_SCHEMA_PATH = join(
  REPO_ROOT,
  "contracts",
  "submit-config.schema.json",
);

/** Exact degraded-hygiene note (DP-J §8 / submission.template.md). */
export const HYGIENE_UNAVAILABLE_NOTE =
  "> Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06).";

/** Safe defaults (GOV-RES-02) — identical to the checked-in generic config. */
export const DEFAULT_CONFIG = {
  version: "1.0.0",
  output: { path: "submission.md", format: "markdown" as const },
  fieldLabels: {
    tagline: "Tagline",
    target_user: "Target User",
    why_ai: "Why AI",
    tech_stack: "Tech Stack",
    disclosure: "Disclosure / Provenance",
  },
  hygiene: { enabled: true, reportPath: "hygiene-report.md" },
  disclosure: { include_excluded_footnote: false },
};

export interface LoadedConfig {
  config: Record<string, unknown>;
  warnings: string[];
}

/** Load + RES-04-validate config/submit.json. Absent default -> pure
 * DEFAULT_CONFIG; explicit-but-malformed -> warn + safe defaults, never
 * crash (GOV-RES-02). */
export function loadSubmitConfig(configPath?: string | null): LoadedConfig {
  const path = configPath ? configPath : DEFAULT_SUBMIT_CONFIG_PATH;
  let parsed: unknown;
  let schema: object;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
    schema = JSON.parse(readFileSync(SUBMIT_CONFIG_SCHEMA_PATH, "utf8")) as object;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } catch (err) {
    if (!configPath) return { config: structuredClone(DEFAULT_CONFIG), warnings: [] };
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warnings: [
        `warn: submit config unreadable at ${path}: ${(err as Error).message} — using safe defaults (GOV-RES-02)`,
      ],
    };
  }
  const result = validate(schema, parsed);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.path} ${e.message}`).join("; ");
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warnings: [
        `warn: submit config invalid at ${path}: ${detail} — using safe defaults (GOV-RES-02)`,
      ],
    };
  }
  return { config: parsed as Record<string, unknown>, warnings: [] };
}

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HYGIENE_SECTION_RE = /\n## Hygiene \(advisory\)\n[\s\S]*?(?=\n## |$)/;

function render(template: string, replacements: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

export interface FormatSubmissionOptions extends ExtractFieldsOptions {
  /** Advisory event_profile.json:submission_fields label seed. */
  eventProfileSubmissionFields?: readonly string[] | null;
  /** Pre-rendered hygiene section body; defaults to the unavailable note. */
  hygieneSummary?: string | null;
  /** ISO-8601 generated_at stamp; injected for determinism (SUBMIT-04). */
  now?: string | null;
}

export interface FormattedSubmission {
  markdown: string;
  frontmatter: string;
  not_extracted_fields: string[];
}

/** Pure SUBMIT-04 assembly. Gapped canonical fields render the exact
 * SUBMIT-RES-01 gap marker and are tracked in the doc frontmatter's
 * not_extracted_fields. Template authoring-guidance HTML comments are
 * stripped from rendered output. */
export function formatSubmission(
  planText: string,
  manifestProviders: string[],
  disclosureText: string | null,
  config: Record<string, unknown>,
  options: FormatSubmissionOptions = {},
): FormattedSubmission {
  const {
    eventProfileSubmissionFields,
    providerLabels,
    frontmatter,
    frontmatterValid,
    hygieneSummary,
    now,
    techTagSections,
  } = options;

  const extracted = extractFields(planText, manifestProviders, {
    techTagSections,
    providerLabels,
    frontmatter,
    frontmatterValid,
  });
  const labels = resolveLabels(
    config.fieldLabels as Partial<Record<CanonicalField, string>> | undefined,
    eventProfileSubmissionFields ?? null,
  );
  const disclosure = embedDisclosure(disclosureText);

  const notExtracted: string[] = [...extracted.not_extracted_fields];
  if (disclosure.missing) notExtracted.push("disclosure");

  const replacements: Record<string, string> = {
    generated_at: now ?? "",
    not_extracted_fields: JSON.stringify(notExtracted),
  };
  for (const canonical of ["tagline", "target_user", "why_ai", "tech_stack"] as const) {
    const raw: string | string[] = extracted[canonical];
    const text = canonical === "tech_stack" ? (raw as string[]).join(", ") : String(raw);
    replacements[`label_${canonical}`] = labels[canonical];
    replacements[canonical] = text || GAP_MARKER;
  }
  replacements.label_disclosure = labels.disclosure;
  replacements.disclosure = disclosure.text;
  replacements.hygiene_summary = hygieneSummary || HYGIENE_UNAVAILABLE_NOTE;

  let doc = readFileSync(SUBMIT_TEMPLATE_PATH, "utf8").replace(COMMENT_RE, "");
  doc = render(doc, replacements).trim();
  const hygieneEnabled =
    (config.hygiene as { enabled?: boolean } | undefined)?.enabled ?? true;
  if (!hygieneEnabled) doc = doc.replace(HYGIENE_SECTION_RE, "").trim();

  const frontmatterBlock = [
    "---",
    'version: "1.0.0"',
    `generated_at: "${now ?? ""}"`,
    `not_extracted_fields: ${JSON.stringify(notExtracted)}`,
    "---",
  ].join("\n");
  return {
    markdown: `${frontmatterBlock}\n\n${doc}\n`,
    frontmatter: frontmatterBlock,
    not_extracted_fields: notExtracted,
  };
}
