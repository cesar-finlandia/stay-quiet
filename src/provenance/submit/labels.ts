// Requirement IDs: SUBMIT-03, SUBMIT-REU-01, PROFILE-05, GOV-RES-02
// SUBMIT-03 field-label resolution — TypeScript twin of
// src/provenance/submit/labels.py (DP-J §5.3). Labels are structural, never
// platform copy (SUBMIT-REU-01).
//
// Precedence (DP-J §7):
//   1. config/submit.json:fieldLabels        (explicit, wins)
//   2. event_profile.json:submission_fields  (advisory fuzzy seed, PROFILE-05)
//   3. hardcoded generic English fallback
// Non-canonical profile fields (e.g. `repo_url`) are ignored.

/** Canonical fields whose section headings are label-driven. */
export const CANONICAL_FIELDS = [
  "tagline",
  "target_user",
  "why_ai",
  "tech_stack",
  "disclosure",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** Hardcoded generic English fallback (tier 3) — mirrors config/submit.json. */
export const GENERIC_ENGLISH_LABELS: Record<CanonicalField, string> = {
  tagline: "Tagline",
  target_user: "Target User",
  why_ai: "Why AI",
  tech_stack: "Tech Stack",
  disclosure: "Disclosure / Provenance",
};

// Fuzzy seed table (DP-J §5.3): normalized submission_fields string ->
// canonical field it seeds. Normalization = lowercase + strip non-alphanum.
const FUZZY_SEED_MAP: Record<string, CanonicalField> = {
  title: "tagline",
  tagline: "tagline",
  headline: "tagline",
  targetuser: "target_user",
  specificuser: "target_user",
  builtfor: "target_user",
  user: "target_user",
  persona: "target_user",
  audience: "target_user",
  whyai: "why_ai",
  techstack: "tech_stack",
  builtwith: "tech_stack",
  disclosure: "disclosure",
  provenance: "disclosure",
  disclosureprovenance: "disclosure",
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Resolve display labels per canonical field (DP-J §5.3 precedence). */
export function resolveLabels(
  configFieldLabels: Partial<Record<CanonicalField, string>> | null | undefined,
  eventProfileSubmissionFields: readonly string[] | null | undefined,
): Record<CanonicalField, string> {
  const labels: Record<string, string> = { ...GENERIC_ENGLISH_LABELS };

  // Tier 2 — advisory PROFILE-05 seed.
  if (eventProfileSubmissionFields) {
    for (const raw of eventProfileSubmissionFields) {
      if (typeof raw !== "string") continue;
      const canonical = FUZZY_SEED_MAP[normalize(raw)];
      if (
        canonical &&
        !(configFieldLabels && Object.prototype.hasOwnProperty.call(configFieldLabels, canonical))
      ) {
        labels[canonical] = raw;
      }
    }
  }

  // Tier 1 — explicit config wins over everything.
  if (configFieldLabels) {
    for (const canonical of CANONICAL_FIELDS) {
      const value = configFieldLabels[canonical];
      if (typeof value === "string" && value.trim()) labels[canonical] = value.trim();
    }
  }

  return Object.fromEntries(
    CANONICAL_FIELDS.map((canonical) => [
      canonical,
      labels[canonical] ?? GENERIC_ENGLISH_LABELS[canonical],
    ]),
  ) as Record<CanonicalField, string>;
}
