<!-- Requirement IDs: DEMODRIVE-01..05, DEMODRIVE-RES-01/02, DEMODRIVE-REU-01/02, NONGOAL-14, XCUT-06, XCUT-08 | Owned by M14 (DP-D2b §8.3/§13) -->

# DEMODRIVE — Golden-Path Demo Driver

## Purpose

`demodrive` replays a **golden-path click sequence** against a running UI instance and captures
the footage judges see: one continuous `video.webm` plus a discrete `screenshot.png` at every
step boundary (`DEMODRIVE-03`). The data source is **never a live, unpredictable backend** —
exactly two sources exist (`DEMODRIVE-01`):

1. `--data-source mock` — replay a MOCK-01 synthetic-event script through the same TRN-04
   publisher a real backend uses (indistinguishable on the wire).
2. `--data-source cache` — read already-recorded envelopes from the RES-05 golden-path cache.

The tool is fully offline once mock/cache data is present (`DEMODRIVE-RES-02`): all requests
that do not target the local UI or the local feeder are blocked before egress.

```bash
# one-time setup (opt-in install per GOV-MIN-04):
pnpm add -D @playwright/test@1.62.1 && npx playwright install chromium
```

## Configuration

| Knob | Where | Default | Notes |
|---|---|---|---|
| Click sequence | `--script <file>` | required | JSON validated via RES-04 against `contracts/demodrive-script.schema.json`; draft from `examples/dummy-fixtures/demodrive/click-script.example.json` |
| Browser / video / viewport / timeouts | `config/demodrive.json` (optional) | §8.1 defaults | missing file → all defaults; malformed → warn + defaults, never crash |
| Data source | `--data-source mock\|cache`, script `data_source.kind` | `mock` | `cache` requires `--cache-key` or `data_source.cache_key` |
| Output root | `--out <dir>`, config `output.root` | `assets/demodrive` | run folder `<root>/<YYYYMMDD-HHmmss>/<step-id>/` |
| Layout | `--layout`, script/config `layout` | `single-focus` | dashboard is non-default per UI-06 and logged as such |
| Base URL | env `DEMODRIVE_BASE_URL`, script `base_url` | `http://localhost:5173` | UI must already be running (`npm run dev`) |

Output layout (`DEMODRIVE-05`) — predictable for external editors:

```
assets/demodrive/<timestamp>/
├── video.webm                  # context-level recording, finalized atomically
├── <step-id>/screenshot.png    # boundary screenshot after wait_after_ms
├── <step-id>/video.webm        # convenience link/copy of ../video.webm
├── <step-id>/actions/*.png     # intra-step screenshots (001-click-….png)
└── demodrive-error.json        # only on failure: {failed_step, step_index, …}
```

## Worked Example

Terminal 1 — start the UI:

```bash
npm run dev            # http://localhost:5173
```

Terminal 2 — capture against the bundled dummy flow (zero manual steps, DEMODRIVE-AC-01):

```bash
npx vite-node src/ideation/demodrive/cli.ts capture \
  --script examples/dummy-fixtures/demodrive/click-script.example.json \
  --data-source mock
# alias: npm run demodrive:capture -- --script …
```

Dry-run validation without a browser:

```bash
npm run demodrive -- validate --script examples/dummy-fixtures/demodrive/click-script.example.json
```

How to write a click-sequence — selector guidance (theme-resilient first,
`DEMODRIVE-REU-02`; selectors are author-supplied at runtime, never hardcoded):

| Selector style | Example | When to prefer | Theme resilience |
|---|---|---|---|
| Role | `getByRole('button', {name: 'Open detail'})` | Preferred — survives theme swaps (UI-04) | High |
| Test ID | `[data-testid='detail-trigger']` | When role ambiguous | High — test IDs are theme-independent |
| CSS | `css=.list >> nth=0` | Last resort | Lower — layout may vary per theme |

Action semantics: `navigate` → `page.goto(value ?? base_url)`; `click` / `fill` /
`wait_for` via `page.locator(selector)` with an optional visible-state assert using
`timeout_ms`; `screenshot` writes an intra-step PNG into `actions/`;
`wait_ms` paces between intra-step actions. Every step ends with a `wait_after_ms`
pause and the mandatory boundary screenshot.

## What This Does Not Contain

This tool captures footage only — it does not edit or assemble the final video.
Import `assets/demodrive/<timestamp>/` into your editor (`NONGOAL-14`). There is no
trimming, transcoding, concatenation, text overlay, or audio muxing anywhere in this
module, and no domain screen names or selectors live in its source — flows are pure
runtime config (`DEMODRIVE-REU-01`). On mid-sequence failure the driver stops cleanly,
finalizes the video atomically, preserves all already-captured assets, and writes
`demodrive-error.json` naming the failed step (`DEMODRIVE-RES-01`).
