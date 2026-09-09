<!--
Requirement IDs: SCRIPT-01, SCRIPT-03, SCRIPT-RES-01 | DP-D2a §4.3/§6.4
Markdown skeleton SCRIPT falls back to on RES-01 failure ("blank timestamped
template — headers only, no generated copy"). generate.ts renders this shape
from the live TimingConfig (accurate mm:ss windows) rather than copying this
file byte-for-byte; the file is the human-readable contract of the fallback.
The `▶ LIVE DEMO` row is preserved so recording never opens on a title card
(SCRIPT-03), and every Visual cue below is already valid against
manifest + contracts/ui-screen-catalog.json (no SCRIPT-RES-02 violation).
-->
---
script_version: "1.0.0"
total_minutes: 3
timing_source: timing.yaml
live_section: live-demo
generated_at: 2026-03-15T09:14:00Z
fallback: RES-01 degraded — blank template
---

# Script — Pitch Video (3:00) — DRAFT TEMPLATE — fill spoken text manually

> Generation failed or RES-01 exhausted — headers and timestamps preserved so recording can proceed with manual scripting.

| Time | Section | Spoken | Visual |
|------|---------|--------|--------|
| 00:00–00:30 | Problem | > **TODO:** Spoken text — generation failed — fill from winning_project_plan.md § Problem Framing | Visual: TODO — select from manifest UI screens |
| 00:30–01:30 | **Live Demo** | > **TODO:** Spoken text — generation failed — describe the assembled flow live | **▶ LIVE DEMO — moving capture** — Visual: TODO — select from manifest UI screens |
| 01:30–02:30 | Business Value | > **TODO:** Business Value spoken text — fill from winning_project_plan.md § Business Value | Visual: TODO — select from manifest UI screens |
| 02:30–03:00 | Team & Roadmap | > **TODO:** Team & ask — no source in winning_project_plan.md — fill manually | Visual: TODO — select from manifest UI screens |
