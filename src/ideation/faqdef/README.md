<!-- Requirement IDs: FAQDEF-01..05, FAQDEF-RES-01/02, FAQDEF-REU-01/02, XCUT-06, XCUT-08 | Owned by M14 (DP-D2b §8.3/§13) -->

# FAQDEF — Judge Q&A Defense Trainer

## Purpose

`faqdef` prepares you for the Hour 60–72 judge Q&A: it derives an anticipated,
axis-tagged question set from what your project actually is — the assembled
manifest, the PROV-05 architecture summary (reused verbatim, never re-derived),
and `winning_project_plan.md` — and drafts a grounded answer for each one
(`FAQDEF-01..03`). Answers may cite **only** the plan / manifest / disclosure /
event profile; any figure or claim not covered by those inputs is rewritten to
an explicit "not stated" gap so nothing unverified is ever rehearsed
(`FAQDEF-RES-02`).

This tool prepares defense material only — it does not change or improve the
underlying project.

## Configuration

| Knob | Where | Default | Notes |
|---|---|---|---|
| Question count | config/faqdef.json `question_count`, env `FAQDEF_QUESTION_COUNT` | `18` | validated 5–30; warned outside 15–20 |
| Axes + weights | config/faqdef.json | fixed 4 axes @ 1.0 | Presentation / Business Value / Application of Technology / Originality |
| Sponsor tracks | event_profile.json `tracks.sponsors[]`, else plan frontmatter `sponsor_tracks` | on (`include_sponsor_tracks`) | absent inputs never block generation (PROFILE-05) |
| Rehearsal budget | config/faqdef.json `rehearsal.per_question_budget_s`, env `FAQDEF_BUDGET_S` | `90` s | CLI `--budget` wins; range 30–300; expiry auto-submits your buffer |
| Rehearsal subset | config/faqdef.json `rehearsal.default_subset_size`, CLI `--count` | `5` | sampled without replacement, weighted toward ungrounded answers |
| Axes drill | CLI `--axes business_value,application_of_technology` | all | filters the pool before sampling |
| Persona tone | CLI `--no-strict` | strict on | friendly mode for learning, not the default |
| Models | shared `config/model-profiles.json` roles `faqdef_generator` / `faqdef_judge` | `analyst-balanced` / `strict-judge` | swap provider there only — never in code |

Outputs (atomic writes): `docs/qa/qa-sheet.json` (machine, RES-04 validated)
and `docs/qa/qa-sheet.md` (human). Any `not_stated` answer renders prefixed
with `WARNING: Unverified —`.

## Worked Example

```bash
# 1) generate the defense sheet from the dummy fixtures
npm run faqdef:generate -- generate \
  --plan examples/dummy-fixtures/pgm/winning_project_plan.example.md \
  --manifest examples/dummy-fixtures/assembly/manifest.example.json \
  --disclosure disclosure.md \
  --out docs/qa

# 2) rehearse against the sheet (interactive; not persisted)
npm run faqdef -- rehearse --qa docs/qa/qa-sheet.md --count 5 --budget 90
# axes drill: npm run faqdef -- rehearse --qa docs/qa/qa-sheet.md --axes business_value
```

If the LLM call exhausts RES-01 retries (offline, no key, provider down), the
generator writes `docs/qa/qa-sheet.fallback.md` from the static generic
checklist and exits 0 — preparation is degraded, never blocked
(`FAQDEF-RES-01`).

## What This Does Not Contain

No hard-coded question bank and no domain nouns live in this module's source —
every question is derived at runtime from your inputs (`FAQDEF-REU-01`). The
strict-judge persona template is generic and reusable across events
(`FAQDEF-REU-02`). The rehearsal session is not persisted: typed answers and
feedback live only in terminal scrollback, and no artifact of your project is
modified by this tool.
