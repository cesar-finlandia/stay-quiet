<!--
Requirement IDs: DECKGEN-01, DECKGEN-05, DECKGEN-06, DECKGEN-REU-01 | DP-D2a §6.2 / §8.2
REFERENCE ONLY — never copied to output. Documents the interior-marker convention
that src/ideation/deckgen/populate.ts owns in every populated slide file.

The canonical PIT-01 skeletons live in templates/pitch-deck/ (M12, frozen order
01→08). On a fresh skeleton, populate.ts REPLACES everything from the first HTML
comment with a bracketed interior; on re-runs it re-finds these exact markers and
rewrites only their interior (idempotent, DECKGEN-06). Marp frontmatter is never
touched (DECKGEN-05).

Marker grammar (exactly one pair per slot file):

  <!-- SLOT nn -->        begin marker, nn = 01..08 zero-padded slot number
  ...interior...          ≥1 bullet or ≥1 `> **TODO:**` line — NEVER blank
  <!-- /SLOT nn -->       end marker

Worked example — 02-problem.md after population:

---
marp: true
theme: chassis
...
---

# Problem

<!-- SLOT 02 -->
## Problem

- <phrased or extractive bullet from ## Problem Framing>
- Evidence: r/<subreddit>, <rough_date>
<!-- /SLOT 02 -->

Interior content rules:
- Every textual interior is either a verbatim plan excerpt or LLM-phrased bullets
  whose source nouns come from the plan excerpt (deck-phrase.prompt.md mandate).
- Any slot whose sources are missing or whose RES-01-wrapped phrasing degraded
  carries the §3.2 literal instead:
  `> **TODO:** <Slot Name> — <reason> — fill manually.`
  and, for an LLM failure, the raw excerpt preserved in the following blockquote.
- Slots 04 (demo), 05 (architecture) and 08 (disclosure) are never LLM-phrased;
  08 is a byte-verbatim PROV-01 marker replacement (DECKGEN-02).
-->
