// Requirement IDs: PROV-05, XCUT-08
// Architecture summary derivation (DP-J §3.2, §4.5) — deterministic one
// paragraph (2–5 sentences, 80..1200 chars) rendered from the SAME manifest +
// contracts/component-catalog.json inputs as the disclosure. No LLM call, no
// winning_project_plan.md read (FAQDEF-02 consumes the output verbatim per
// contract #8 — re-deriving would be a GOV-REU-03 coupling violation).
//
// Template (src/provenance/provo/templates/architecture-summary.template.md):
//   This project assembles {{count}} chassis component(s) — {{id_list}} —
//   on chassis {{short_sha}}. {{role_sentences}}
//
// Imports limited to src/resilience/*, contracts/* and Node stdlib
// (GOV-REU-03, DP-J §9.4).

import type {
  AssemblyManifest,
  ComponentCatalog,
  DisclosureConfig,
  GenerateOptions,
} from "./generate.js";
import { deriveRoleSentence, lookupCatalogEntry } from "./generate.js";

export interface SummaryResult {
  /** The paragraph WITHOUT trailing newline (callers add it when writing). */
  summary_text: string;
}

const SUMMARY_MIN_CHARS = 80;
const SUMMARY_MAX_CHARS = 1200;

/** Strip one trailing period so clause joining stays clean; re-added at end. */
function trimTrailingPeriod(text: string): string {
  return text.replace(/\.$/, "").trim();
}

/**
 * buildArchitectureSummary — shared renderer used by generateDisclosure (so
 * both artifacts share one hash/timestamp pass) and by generateSummary.
 */
export function buildArchitectureSummary(
  manifest: AssemblyManifest,
  catalog: ComponentCatalog,
  config: DisclosureConfig = {},
  options: GenerateOptions = {},
): SummaryResult {
  void options; // reserved for future template knobs; keeps signature stable
  const included = manifest.components.filter((c) => c.included).map((c) => c.id);
  const shortShaLength = config.short_sha_length ?? 7;
  const shortSha = manifest.chassis_version.slice(0, shortShaLength);

  // {{role_sentences}}: "<id> provides <catalog first-sentence role>" per
  // included component in manifest order, joined with "; ".
  const clauses = included.map((id) => {
    const entry = lookupCatalogEntry(catalog, id);
    return `${id} provides ${trimTrailingPeriod(deriveRoleSentence(entry))}`;
  });
  let roleSentences = clauses.join("; ");
  if (roleSentences.length > 0) roleSentences += ".";

  const header = `This project assembles ${included.length} chassis component(s) — ${included.join(", ")} — on chassis ${shortSha}.`;
  let text = `${header} ${roleSentences}`.trim();

  // Schema bound contracts/disclosure.schema.json: architecture_summary is
  // minLength 20 / maxLength 1200. Every id already appears in the header's
  // id_list, so deterministic truncation of an over-long role tail preserves
  // the §10.1 containment guarantee ("contains every components_reused id").
  if (text.length > SUMMARY_MAX_CHARS) {
    text = text.slice(0, SUMMARY_MAX_CHARS - 1).replace(/\s+\S*$/, "") + "…";
  }
  return { summary_text: text };
}

/** Minimum-length guard surfaced as data (never padded with invented text). */
export function isSummaryTooShort(summaryText: string): boolean {
  return summaryText.length < SUMMARY_MIN_CHARS;
}

/**
 * generateSummary — PROV-05 standalone entry (DP-J §4.5): pure function of an
 * already-validated manifest + catalog (+ optional config). The CLI validates
 * the manifest via parseAndValidateManifest before calling this.
 */
export function generateSummary(
  manifest: AssemblyManifest,
  catalog: ComponentCatalog,
  config: DisclosureConfig = {},
  options: GenerateOptions = {},
): string {
  return buildArchitectureSummary(manifest, catalog, config, options).summary_text;
}
