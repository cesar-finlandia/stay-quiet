# Requirement IDs: SUBMIT-02, SUBMIT-RES-01, XCUT-08
"""SUBMIT-02 verbatim disclosure embedding — Python twin of
src/provenance/submit/embed.ts (DP-J §5.2). The bytes of disclosure.md (the
single source written by PROV-01, contract #8) are embedded unmodified under
`## Disclosure / Provenance` — no paraphrasing, no truncation, no
re-derivation from the manifest. Only normalization allowed: a single
trailing-newline trim. When PROV has not run yet, the explicit gap placeholder
is rendered and "disclosure" is added to not_extracted_fields
(SUBMIT-RES-01) — never a silent omission."""

from __future__ import annotations

from typing import Dict, Optional

# Exact gap placeholder from DP-J §5.2 / submission.template.md.
DISCLOSURE_GAP_PLACEHOLDER = (
    "> Disclosure not yet generated — run: provo generate --manifest assembly.manifest.json"
)

__all__ = ["DISCLOSURE_GAP_PLACEHOLDER", "embed_disclosure"]


def embed_disclosure(disclosure_text: Optional[str]) -> Dict[str, object]:
    """Return {text, missing} for the disclosure section body.

    disclosure_text — bytes of disclosure.md as text, or None when the file
                      is absent/unreadable. The only normalization is
                      trimming trailing newlines (DP-J §5.2 byte-equality is
                      asserted modulo exactly that)."""
    if disclosure_text is None:
        return {"text": DISCLOSURE_GAP_PLACEHOLDER, "missing": True}
    return {"text": disclosure_text.rstrip("\n"), "missing": False}
