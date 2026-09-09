<!-- Requirement IDs: PROV-01, PROV-02, PROV-04, XCUT-08 | Owned by M11 (DP-J §3.1, §9.2) | Template v1.0.0.
     Rendered by `provo generate` from assembly.manifest.json (+ optional ai_tools.json).
     WARNING: do not hand-edit accuracy — the text must claim exactly the manifest's included
     components (PROV-04). Stylistic polish of role wording only; consumers (DECKGEN-02 /
     SUBMIT-02 / FAQDEF-02, contract #8) reuse the generated file verbatim. -->
# Provenance & Disclosure

> Generated from `assembly.manifest.json` — do not hand-edit accuracy; polish wording only if needed. Verbatim reuse by DECKGEN-02 / SUBMIT-02 / FAQDEF-02 (contract 8).

This project reuses **{{count}}** component(s) from the Hackathon Chassis Repository (`{{short_sha}}` / `LICENSE: MIT`).

## Reused components ({{count}})

{{bullets}}
<!-- {{excluded_section}} — rendered only when config/disclosure.json:include_excluded_footnote is true;
     otherwise absent entirely. Shape when enabled:
### Components not included
- **<id>** — excluded per assembly.manifest.json.
-->
<!-- {{ai_section}} — rendered only when ai_tool_log is non-empty (PROV-02 / PROV-RES-01);
     otherwise this whole section is absent. Shape when present:
## AI assistance

- **{{tool}}** — {{scope}}
-->

## How to cite

Cite the chassis repository as prior scaffolding per `XCUT-01` / `LICENSE`. Full disclosure source: `assembly.manifest.json` (`manifest_version {{manifest_version}}`, `chassis_version {{chassis_version}}`).

_Generated at {{generated_at}} from manifest hash {{source_manifest_hash}}._
