# SCRIPT — Pitch Video Script & Storyboard Generator (M13)

Requirement IDs: `SCRIPT-01..05`, `SCRIPT-REU-01/02`, `SCRIPT-RES-01/02`, `SCRIPT-AC-01/02`, `PROFILE-05`, `RES-01` — implements `design_documents/design_plans/DP-D2a-deckgen-script.md` §4.

## Status — this module produces the EARLY DRAFT, not the recording script

As of 2026-09-09 the authoritative recording script for an entry is
`design_documents/demo-video-script.md`, authored by the entry's **DP-SCRIPT** design plan against
`templates/demo-video-script.spec.md`. That plan runs after the product is built and measures every
figure by executing it; this module cannot, because it is a pure function of the plan + manifest and
never sees the running product.

Keep using this module for the Hour-0 draft (it gives accurate timestamp windows early). But when
both exist, `demo-video-script.md` wins and the root `script.md` is the superseded draft — the spec
requires DP-SCRIPT to say so in one line at the top of `script.md`. Do not reconcile them by hand.

## Purpose

Turns `winning_project_plan.md` + `assembly.manifest.json` (+ optional timing config / event profile) into a timestamped Markdown recording blueprint: one row per section with an mm:ss window, a spoken paragraph and a visual cue naming a real UI screen.

## CLI

```bash
script generate --plan winning_project_plan.md --manifest assembly.manifest.json \
  --config timing.yaml [--event-profile event_profile.json] --out script.md
script validate --plan <p> --manifest <m> --config <timing.yaml>   # dry-run (timing sum check)
script:generate ...  script:validate ...                            # colon aliases
```

Exit codes: `0` success (TODOs / blank-template fallback are warns); `1` invalid or sum-mismatched timing (`Fix sum == total.`).

## Default 4-part timing (SCRIPT-01, fully config-driven)

| Section | minutes | window |
|---|---|---|
| Problem | 0.5 | 00:00–00:30 |
| Live Demo | 1.0 (`live: true`) | 00:30–01:30 |
| Business Value | 1.0 | 01:30–02:30 |
| Team & Roadmap | 0.5 | 02:30–03:00 |

Total precedence: explicit `timing.yaml:total_minutes` → `event_profile.json:video_limits.max_minutes` (PROFILE-05 advisory) → fallback 3.0. With no `--config`, the checked-in `templates/script-timing.example.yaml` is used.

### Changing timing

Edit `total_minutes` + per-section `minutes` in your yaml, or point `--config` at a
different yaml (see `examples/dummy-fixtures/script/timing.4min.example.yaml` for a
certified 4-minute variant). Adding a 5th section is config-only: append a list entry
(`id`, `title`, `minutes`, optional `live: true`) — no code change, no minutes hardcoded in
this module (the only numeric literal is the 3.0 fallback in `defaultTotal.ts`).

## Guarantees

- **SCRIPT-03** — the `live:true` section's row carries the literal `▶ LIVE DEMO — moving capture` (U+25B6); static/title-card cues there are refused and rewritten. If no section has `live:true`, it is assigned to the earliest non-Problem section with `warn: no live:true in timing — assigned to Live Demo`.
- **SCRIPT-04** — Business Value figures come only from the plan's `## Business Value { specific_user, tam_figure, revenue_model, why_ai }` bullets + `## Why Now`. Every numeric token in the Business Value spoken cell is audited against `tam_figure`/`revenue_model`; a stray number rewrites the cell to
  `> **TODO:** Business Value spoken text — numeric claim not found in winning_project_plan.md §## Business Value — revise plan and re-run script generate.` plus `warn: invented claim <token>`.
- **SCRIPT-RES-01** — ONE RES-01-wrapped LLM call phrases spoken rhetoric for the whole script (timeout 20 s, retries 1, backoff base 400/max 3000 + jitter, fallback `none`; role `script_generator` via the shared `config/model-profiles.json`). Any failure writes the blank timestamped template (`templates/script.template.md` shape): accurate windows, TODO spoken cells, valid visual cues, preserved ▶ LIVE DEMO row — never an empty file.
- **SCRIPT-RES-02** — visual vocabulary = `contracts/ui-screen-catalog.json` ∪ manifest-included component screens. The prompt lists allowed ids; a post-generation pass rewrites any invented id to `Visual: TODO — select from manifest UI screens: …` + warn. With `platform/ui` excluded every cue degrades to `Visual: TODO — no UI component selected in manifest — add platform/ui or point to live demo URL manually.`
- **SCRIPT-05** — pure function of its inputs; atomic tmp+rename; diff-before-write (unchanged inputs keep the previous `generated_at` so bytes stay identical).

## What This Does Not Contain

No video editing/capture (`DEMODRIVE`, M14), no domain content (Acme strings exist only under `examples/dummy-fixtures/`), no disclosure rendering (PROV-01 owns it), no hardcoded model ids or per-event code branches.

## Tests

```bash
npx vitest run tests/script/
```
