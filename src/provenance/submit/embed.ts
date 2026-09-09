// Requirement IDs: SUBMIT-02, SUBMIT-RES-01, XCUT-08
// SUBMIT-02 verbatim disclosure embedding — TypeScript twin of
// src/provenance/submit/embed.py (DP-J §5.2). The bytes of disclosure.md
// (the single source written by PROV-01, contract #8) are embedded
// unmodified under `## Disclosure / Provenance`. Only normalization allowed:
// a single trailing-newline trim. Missing PROV output renders the explicit
// gap placeholder and adds "disclosure" to not_extracted_fields.

/** Exact gap placeholder from DP-J §5.2 / submission.template.md. */
export const DISCLOSURE_GAP_PLACEHOLDER =
  "> Disclosure not yet generated — run: provo generate --manifest assembly.manifest.json";

export interface EmbeddedDisclosure {
  text: string;
  missing: boolean;
}

/** Embed one disclosure document's text. `disclosureText === null` means the
 * file is absent/unreadable. The only normalization is trimming trailing
 * newlines (DP-J §5.2 byte-equality is asserted modulo exactly that). */
export function embedDisclosure(disclosureText: string | null): EmbeddedDisclosure {
  if (disclosureText === null) {
    return { text: DISCLOSURE_GAP_PLACEHOLDER, missing: true };
  }
  return { text: disclosureText.replace(/\n+$/, ""), missing: false };
}
