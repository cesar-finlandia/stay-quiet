// Requirement IDs: RES-04, ASM-RES-01, PROV-02, XCUT-08
// Thin wrapper over src/resilience/validate for the disclosure generator's
// inputs — DP-J §4.1 (non-duplicate): all ajv/compilation logic stays in
// RES-04; this module only pins the frozen contract
// contracts/assembly-manifest.schema.json plus the §4.2 inline ai-log entry
// schema so callers never hand-roll schema loading or re-implement
// validation. TypeScript twin of src/provenance/provo/validate.py.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../../resilience/index.js";
import type { ValidationResult } from "../../resilience/validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const ASSEMBLY_MANIFEST_SCHEMA_PATH = join(
  REPO_ROOT,
  "contracts",
  "assembly-manifest.schema.json",
);
export const CATALOG_PATH = join(REPO_ROOT, "contracts", "component-catalog.json");
export const DEFAULT_DISCLOSURE_CONFIG_PATH = join(
  HERE,
  "..",
  "config",
  "disclosure.json",
);
export const DISCLOSURE_CONFIG_SCHEMA_PATH = join(
  REPO_ROOT,
  "contracts",
  "disclosure-config.schema.json",
);

/** The authoritative manifest contract, loaded defensively (absent/malformed
 * → throw: a missing schema is a repo integrity bug, not a degradation). */
export function loadAssemblyManifestSchema(): object {
  return JSON.parse(readFileSync(ASSEMBLY_MANIFEST_SCHEMA_PATH, "utf8")) as object;
}

/** Validate one parsed AssemblyManifest against the frozen contract. */
export function validateManifest(data: unknown): ValidationResult {
  return validate(loadAssemblyManifestSchema(), data);
}

/** DP-J §4.2 inline shape: tool 1–40 chars, scope 5–400 chars. */
export const AI_LOG_ENTRY_SCHEMA = {
  $id: "https://chassis/contracts/ai-log-entry.inline.json",
  title: "AiToolLogEntry",
  type: "object",
  additionalProperties: false,
  required: ["tool", "scope"],
  properties: {
    tool: { type: "string", minLength: 1, maxLength: 40 },
    scope: { type: "string", minLength: 5, maxLength: 400 },
  },
} as object;

/** Validate one AI-tool log entry against the §4.2 inline schema. */
export function validateAiLogEntry(data: unknown): ValidationResult {
  return validate(AI_LOG_ENTRY_SCHEMA, data);
}

export { validate };
export type { ValidationResult };
