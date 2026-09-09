// Requirement IDs: FAQDEF-RES-02, FAQDEF-03, XCUT-08 | Owned by M14 step 4 (DP-D2b §5.4/§6.2)
// Anti-fabrication validator. An answer may cite ONLY the grounded inputs
// (plan / manifest / PROV disclosure / event profile). Any numeric figure
// ($, %, B/M suffixes, USD) or feature noun (integration, pipeline, benchmark,
// team, latency) that does NOT appear verbatim in plan excerpts ∪ manifest
// component ids ∪ disclosure text flags the answer; the entry is rewritten to
// explicit gap form so no absent figure is ever cited to judges.

import type { FaqdefSheetEntry } from "./sheet.js";

export const GAP_ANSWER =
  "> Not stated in winning_project_plan.md / manifest / PROV disclosure — verify before citing.";

/** Inputs the grounding check is allowed to trust. */
export interface GroundingInputs {
  /** Raw bytes of winning_project_plan.md (headings + body + frontmatter). */
  planText: string;
  /** Component ids of the assembled manifest (components.filter(included)). */
  manifestComponentIds: string[];
  /** Raw bytes of disclosure.md / architecture-summary.md (may be empty). */
  disclosureText: string;
}

const FIGURE_PATTERNS: RegExp[] = [
  /\$\d[\d,.]*(?:\s?(?:B|M|bn|million|billion|USD))?/gi, // $12, $12B, $1,200, $3M USD
  /\d+(?:\.\d+)?\s?%/g, // 40%, 4.5 %
  /\b\d+(?:\.\d+)?\s?(?:B|M|bn|million|billion)\b/gi, // 3B, 12 million
  /\b\d+\s?USD\b/gi,
];

const FEATURE_NOUNS = [
  "integration",
  "pipeline",
  "benchmark",
  "team",
  "latency",
] as const;

export interface GroundingFlag {
  id: string;
  token: string;
  kind: "figure" | "noun";
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function findUncoveredTokens(answer: string, corpus: string): GroundingFlag[] {
  const haystack = normalize(corpus);
  const flags: GroundingFlag[] = [];
  for (const pattern of FIGURE_PATTERNS) {
    for (const match of answer.match(pattern) ?? []) {
      if (!haystack.includes(normalize(match))) {
        flags.push({ id: "", token: match.trim(), kind: "figure" });
      }
    }
  }
  for (const noun of FEATURE_NOUNS) {
    const re = new RegExp(`\\b${noun}\\b`, "gi");
    if (re.test(normalize(answer)) && !haystack.includes(noun)) {
      flags.push({ id: "", token: noun, kind: "noun" });
    }
  }
  return flags;
}

/** §6.2 post-generation validator. Returns the entries to persist — flagged
 * answers are REWRITTEN in place to gap form with `citations: ["not_stated"]`
 * and `source_grounding: "not_stated"`. Pure function; never throws. */
export function validateGrounding(
  entries: FaqdefSheetEntry[],
  inputs: GroundingInputs,
): { entries: FaqdefSheetEntry[]; flagged: GroundingFlag[] } {
  const corpus = [
    inputs.planText,
    inputs.manifestComponentIds.join(" "),
    inputs.disclosureText,
  ].join("\n");

  const flagged: GroundingFlag[] = [];
  const out = entries.map((entry) => {
    const tokens = findUncoveredTokens(entry.draft_answer, corpus);
    if (tokens.length === 0) return entry;
    flagged.push(...tokens.map((t) => ({ ...t, id: entry.id })));
    return {
      ...entry,
      draft_answer: GAP_ANSWER,
      citations: ["not_stated"],
      source_grounding: "not_stated" as const,
    };
  });
  return { entries: out, flagged };
}
