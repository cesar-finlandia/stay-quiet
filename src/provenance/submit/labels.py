# Requirement IDs: SUBMIT-03, SUBMIT-REU-01, PROFILE-05, GOV-RES-02
"""SUBMIT-03 field-label resolution — Python twin of
src/provenance/submit/labels.ts (DP-J §5.3). Labels are structural, never
platform copy (SUBMIT-REU-01): they name where a canonical value goes, they
never write copy themselves.

Precedence (DP-J §7):
  1. config/submit.json:fieldLabels        (explicit, wins)
  2. event_profile.json:submission_fields  (advisory fuzzy seed, PROFILE-05)
  3. hardcoded generic English fallback

Non-canonical profile fields (e.g. `repo_url`) are ignored."""

from __future__ import annotations

from typing import Dict, List, Optional

# Canonical fields whose section headings are label-driven.
CANONICAL_FIELDS = ("tagline", "target_user", "why_ai", "tech_stack", "disclosure")

# Hardcoded generic English fallback (tier 3) — mirrors config/submit.json.
GENERIC_ENGLISH_LABELS: Dict[str, str] = {
    "tagline": "Tagline",
    "target_user": "Target User",
    "why_ai": "Why AI",
    "tech_stack": "Tech Stack",
    "disclosure": "Disclosure / Provenance",
}

# Fuzzy seed table (DP-J §5.3): normalized submission_fields string ->
# canonical field it seeds. Normalization = lowercase + strip non-alphanum.
# `repo_url` etc. are absent on purpose: not canonical -> ignored.
_FUZZY_SEED_MAP: Dict[str, str] = {
    "title": "tagline",
    "tagline": "tagline",
    "headline": "tagline",
    "targetuser": "target_user",
    "specificuser": "target_user",
    "builtfor": "target_user",
    "user": "target_user",
    "persona": "target_user",
    "audience": "target_user",
    "whyai": "why_ai",
    "techstack": "tech_stack",
    "builtwith": "tech_stack",
    "disclosure": "disclosure",
    "provenance": "disclosure",
    "disclosureprovenance": "disclosure",
}

def _normalize(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def resolve_labels(
    config_field_labels: Optional[Dict[str, str]],
    event_profile_submission_fields: Optional[List[str]],
) -> Dict[str, str]:
    """Resolve display labels per canonical field (DP-J §5.3 precedence).

    config_field_labels             — validated config/submit.json:fieldLabels
                                      (missing/None entries fall through)
    event_profile_submission_fields — event_profile.json:submission_fields
                                      strings; each fuzzy-matching string
                                      seeds the label ONLY when config does
                                      not override that canonical field.
    """
    labels = dict(GENERIC_ENGLISH_LABELS)  # tier 3 baseline

    # Tier 2 — advisory PROFILE-05 seed.
    if event_profile_submission_fields:
        for raw in event_profile_submission_fields:
            if not isinstance(raw, str):
                continue
            canonical = _FUZZY_SEED_MAP.get(_normalize(raw))
            if canonical and not labels.get(canonical):
                continue  # unreachable today; keeps intent explicit
            if canonical and canonical not in (config_field_labels or {}):
                labels[canonical] = raw

    # Tier 1 — explicit config wins over everything.
    if config_field_labels:
        for canonical in CANONICAL_FIELDS:
            value = config_field_labels.get(canonical)
            if isinstance(value, str) and value.strip():
                labels[canonical] = value.strip()

    return {canonical: labels.get(canonical, GENERIC_ENGLISH_LABELS[canonical])
            for canonical in CANONICAL_FIELDS}


__all__ = [
    "CANONICAL_FIELDS",
    "GENERIC_ENGLISH_LABELS",
    "resolve_labels",
]
