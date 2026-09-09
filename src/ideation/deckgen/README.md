# deckgen — Deck & Diagram Auto-Populator (M13 / DP-D2a)

Requirement IDs: DECKGEN-01…06, DECKGEN-RES-01, DECKGEN-RES-02, XCUT-06.

## What This Does

Populates the frozen PIT-01 pitch-deck skeleton (`templates/pitch-deck/`, M12)
from three single sources:

- `winning_project_plan.md` (contract #7) — textual slots
- `assembly.manifest.json` (contract #6) — `diagram.mmd` (Mermaid `graph TD`)
- `disclosure.md` from PROV-01 (contract #8) — byte-verbatim copy between the
  `<!-- PROV-01:BEGIN -->` / `<!-- PROV-01:END -->` markers; **never** re-derived
  from the manifest.

## CLI

```bash
deckgen populate --plan winning_project_plan.md --manifest assembly.manifest.json \
  --disclosure disclosure.md --out deck/ [--no-llm] [--validate]
deckgen diagram  --manifest assembly.manifest.json --out deck/diagram.mmd
deckgen validate --plan <plan> --manifest <manifest> [--disclosure <disc>]  # dry-run
deckgen:populate ...   # colon alias form (npm-script ergonomics)
```

Exit codes: `0` success (TODOs and RES-02 skeleton fallback are warns) · `1`
blocking failure (invalid manifest, ASM-RES-01 pattern).

## LLM Phrasing (optional, DECKGEN-RES-01)

`--no-llm` skips phrasing entirely — extractive bullets only (offline-viable).
When enabled, bullet phrasing is wrapped by `withResilience` (`src/resilience`,
RES-01: timeout 20s, 1 retry, exponential backoff base 500ms max 4s jitter,
fallback chain `["none"]`). Any failure degrades the affected slot to the TODO
literal below plus a raw-excerpt blockquote — the deck is never blank and the
run never crashes. Model routing lives ONLY in the shared
`config/model-profiles.json` under role `deckgen_phraser`; no model id is
hardcoded anywhere in this directory (GOV-REU-02).

## TODO Marking

Any slot with no equivalent source data or whose LLM call failed carries the
literal (§3.2 — visible rendered AND greppable):

```markdown
> **TODO:** <Slot Name> — <reason> — no source in winning_project_plan.md — fill manually.
```

(`<reason>` names the missing source, e.g. `no source in winning_project_plan.md`;
LLM-failure cases name the degraded role instead.)

Search before submission (both forms — first lists, second counts):

```bash
grep -R "^\> \*\*TODO:" deck/ --include="*.md"   # remaining non-derivable slots
grep -R "^\> \*\*TODO:" deck/ --include="*.md" | wc -l   # count of remaining slots
```

Slot 07 (Ask/Team) is the expected permanent case: `winning_project_plan.md`
(contract #7) has no Team section, so it always renders this TODO.

## What This Does Not Contain

- No domain content — all Acme Corp strings live in `examples/dummy-fixtures/`.
- No manifest-to-disclosure renderer (DECKGEN-02 byte-copy only).
- No video editing/capture (SCRIPT/M14 own the storyboard; DEMODRIVE captures).
- No chart/diagram libraries — SVG via string template, Mermaid as plain text.
- No hardcoded model ids — role resolution via `config/model-profiles.json`.

## Config

`config/deckgen.json` (fallback: `config/defaults.json` here): output dir,
default input paths, live-demo label. CLI flags override config defaults.
