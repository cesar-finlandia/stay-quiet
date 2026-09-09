<!-- Requirement IDs: SUBMIT-01, SUBMIT-02, SUBMIT-03, SUBMIT-04, SUBMIT-RES-01, XCUT-08 | Owned by M11 (DP-J §5, §9.2) | Template v1.0.0.
     Rendered by `submit format` from winning_project_plan.md + assembly.manifest.json +
     disclosure.md + config/submit.json (+ optional event_profile.json). No platform copy of
     its own (SUBMIT-REU-01): section titles below are the generic English fieldLabels from
     config; per-event labels come from config only. Missing fields render the explicit gap
     marker — never blank, never fabricated (SUBMIT-RES-01). -->
<!-- frontmatter: version: 1.0.0 | generated_at: {{generated_at}} | not_extracted_fields: [{{not_extracted_fields}}] -->

# Submission copy

## {{label_tagline}}

{{tagline}}

## {{label_target_user}}

{{target_user}}

## {{label_why_ai}}

{{why_ai}}

## {{label_tech_stack}}

{{tech_stack}}

## {{label_disclosure}}

{{disclosure}}
<!-- {{disclosure}} is the byte-verbatim content of disclosure.md (SUBMIT-02 / contract #8).
     If PROV has not run yet, render instead:
     > Disclosure not yet generated — run: provo generate --manifest assembly.manifest.json
     and add "disclosure" to not_extracted_fields. -->

## Hygiene (advisory)

{{hygiene_summary}}
<!-- Rendered from hygiene-report when config/submit.json:hygiene.enabled; degraded runs emit
     > Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06).
     Flag-only: this section never blocks or modifies anything (NONGOAL-16). -->
