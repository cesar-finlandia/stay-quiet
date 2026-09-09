<!--
  Requirement IDs: UI-03, UI-04, UI-REU-01, XCUT-06 | DP-B §6.3–§6.5, §13
-->

# Platform UI — envelope-only component library

Three independently usable components (`UI-01`) that consume **only**
`EventEnvelope[]` (`UI-05`): `StepStatusIndicator`, `StreamingTextRenderer`,
`CitationDisplay`. Each works standalone (`UI-02`) and against any backend
emitting valid envelopes (`UI-REU-02`); there is no adapter layer. All
user-facing copy is a prop with a default — no hardcoded persona/product text.

## Theming (UI-03 / UI-04)

Identity is a token system: components reference only `var(--ui-*)` tokens and
className hooks — swapping tokens never touches JSX or logic.

* **Token defaults:** `src/platform/ui/tokens.css` (`:root`, minimal theme).
* **Theme overrides:** `src/platform/ui/themes/{minimal,editorial,operator}.css`
  via `:root[data-theme="…"]`. The three themes differ in layout system,
  typography, spacing rhythm, *and* palette — not just colors:
  | Theme | Layout | Type | Rhythm |
  |---|---|---|---|
  | `minimal` | 720px centered single column | Inter 16/1.5 | 8px unit, generous gaps |
  | `editorial` | 960px 12-col grid, asymmetric offsets, left rail | serif ~18/1.7 | 12px unit, hairline rules |
  | `operator` | 1280px dense three-zone console | mono + small caps | 4px unit, radius 1, grid borders |
* **Switch = one config change** (`UI-AC-02`): set `THEME=editorial` (env via
  `src/platform/config/env.ts`) or `config/theme.json { "theme": "editorial" }`,
  then bootstrap calls `resolveTheme(env.theme)`. Unknown values warn and fall
  back to `minimal` (GOV-RES-02). Programmatic: `setTheme("operator")`.
* **Degraded styling:** every theme overrides `--ui-color-degraded-bg`; the
  built-in banner consumes it with a `var()` fallback (step-5 contract).

### Adding a theme

1. Add the id to `ThemeId` in `theme.ts` + a `themes/<id>.css` overriding at
   minimum `--ui-layout-max`, fonts, and `--ui-color-degraded-bg`.
2. Register it in the `themes` record.
3. Add stories under `stories/*.theme.stories.tsx` and extend
   `tests/platform/ui_ac02.test.ts`.

No component file changes required — that is the whole point (`NONGOAL-05`).

## What This Does Not Contain

No persona/copy, no branding, no domain fixtures in library code
(`NONGOAL-01/05/06`): all copy arrives via props; demo content lives in
`examples/dummy-fixtures/` as synthetic Acme Corp/widget only.
