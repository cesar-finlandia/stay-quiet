# Requirement IDs: PROV-05, XCUT-08
"""Architecture summary derivation (DP-J §3.2, §4.5) — deterministic one
paragraph (2–5 sentences, 80..1200 chars) rendered from the SAME manifest +
contracts/component-catalog.json inputs as the disclosure. No LLM call, no
winning_project_plan.md read (FAQDEF-02 consumes the output verbatim per
contract #8). Python mirror of src/provenance/provo/summary.ts.

Template (src/provenance/provo/templates/architecture-summary.template.md):
  This project assembles {{count}} chassis component(s) — {{id_list}} —
  on chassis {{short_sha}}. {{role_sentences}}"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from src.provenance.provo.generate import derive_role_sentence, lookup_catalog_entry

__all__ = ["build_architecture_summary", "generate_summary", "is_summary_too_short"]

SUMMARY_MIN_CHARS = 80
SUMMARY_MAX_CHARS = 1200


def _trim_trailing_period(text: str) -> str:
    return re.sub(r"\.$", "", text).strip()


def build_architecture_summary(
    manifest: Dict[str, Any],
    catalog: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
    now: Optional[str] = None,
) -> str:
    """Shared renderer used by generate_disclosure (one hash/timestamp pass)
    and by generate_summary / `provo summary`. Returns the paragraph WITHOUT a
    trailing newline."""
    config = config or {}
    included = [c["id"] for c in manifest["components"] if c.get("included")]
    short_sha_length = int(config.get("short_sha_length", 7))
    short_sha = manifest["chassis_version"][:short_sha_length]

    # {{role_sentences}}: "<id> provides <catalog first-sentence role>" per
    # included component in manifest order, joined with "; ".
    clauses = [
        f"{cid} provides {_trim_trailing_period(derive_role_sentence(lookup_catalog_entry(catalog, cid)))}"
        for cid in included
    ]
    role_sentences = "; ".join(clauses)
    if role_sentences:
        role_sentences += "."

    header = (
        f"This project assembles {len(included)} chassis component(s) — "
        f"{', '.join(included)} — on chassis {short_sha}."
    )
    text = f"{header} {role_sentences}".strip()

    # Schema bound contracts/disclosure.schema.json: architecture_summary is
    # minLength 20 / maxLength 1200. Every id already appears in the header's
    # id_list, so deterministic truncation of an over-long role tail preserves
    # the §10.1 containment guarantee ("contains every components_reused id").
    if len(text) > SUMMARY_MAX_CHARS:
        text = re.sub(r"\s+\S*$", "", text[: SUMMARY_MAX_CHARS - 1]) + "…"
    return text


def is_summary_too_short(summary_text: str) -> bool:
    """Minimum-length guard surfaced as data (never padded with invented text)."""
    return len(summary_text) < SUMMARY_MIN_CHARS


def generate_summary(
    manifest: Dict[str, Any],
    catalog: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
    now: Optional[str] = None,
) -> str:
    """PROV-05 standalone entry (DP-J §4.5): pure function of an
    already-validated manifest + catalog (+ optional config). The CLI
    validates the manifest via parse_and_validate_manifest before calling."""
    return build_architecture_summary(manifest, catalog, config, now=now)
