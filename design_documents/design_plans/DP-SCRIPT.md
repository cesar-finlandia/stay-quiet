# DP-SCRIPT — The demo-video script, measured from the built product

## §0 Context & blockers

**This plan runs last.** Every one of these must already be true before WU-SCRIPT-01 starts:

* The product is built and runs: DP-FOUND through DP-UI, all verification commands passing.
* **DP-DEPLOY WU-03 has recorded the golden cache** (`python scripts/record_golden.py --check`
  reports eight entries). Without it the offline run produces fallback text and there is nothing
  real to quote.
* DP-DEPLOY WU-04 has either produced a `PUBLIC_URL` or failed and said so — the script must state
  which.
* DP-DEPLOY WU-06 has produced the recorded capture, so the video can be cut even if the live system
  is unavailable on the day.
* DP-SUBMIT has produced `README.md`, `docs/architecture.md` and `disclosure.md`.

If any of the above is missing, stop and report which one. A script written before the product runs
is the single failure this plan exists to prevent.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Produce one file — the demo-video script — that the operator can put on a second monitor and read
top to bottom while recording, with every sentence true of what is on screen.

Requirements: **SQ-N-02** (the measured cycle timings the script quotes), **SQ-N-07** (the script is
a production aid and lives outside the entry repository), and full coverage of the five judging axes
in blueprint §0.3. The binding contract for the file's content is §5 of this plan, reproduced
verbatim from the entry's spec.

## §2 Scope boundaries

### IN — the only file this plan creates

1. `../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md`

That is the entire deliverable. This plan writes no code, changes no product file, and adds nothing
to the entry repository.

### OUT — never create or edit

| File | Owner |
|---|---|
| anything inside the entry repository | every other plan |
| `README.md`, `docs/**`, `disclosure.md`, `submission.md`, `deck/`, `qa/` | DP-SUBMIT |
| the recorded capture | DP-DEPLOY |

One exception to "changes no product file": §6 of the spec allows noting an **optional** one-line
product improvement, with file and line, as a suggestion in the Production Notes. Note it; do not
apply it.

## §3 Interfaces owned

The file shape is fixed by §5 §8 of this plan (nine sections in order). No code interface.

## §4 Interfaces consumed

```python
from engine.agents import run_cycle              # DP-AGENT — the measurement entry point
from src.stayquiet.model import cost_snapshot    # DP-MODEL — token totals and modelled cost
from src.stayquiet.audit import audit_read       # DP-STREAM — the audit lines the video shows
```

```bash
python -m src.stayquiet                          # DP-API — the product the video records
curl -s "$PUBLIC_URL/api/state"                  # DP-API — the deployed state, if WU-04 succeeded
python -m src.cost.cli --json                    # pre-existing cost CLI — machine-readable usage
```

Read for wording, never quoted as measurement: `README.md`, `docs/architecture.md`,
`design_documents/hackathon_brief.md` §4, `src/stayquiet/web/labels.ts` (the on-screen step labels)
and DP-UI §5.6 (the exact on-screen copy).

## §5 The binding spec — reproduced verbatim

Everything between the two markers below is the entry's demo-video-script specification. It is the
single source of truth for what a usable script is. Follow it exactly; where it and any other
document disagree, it wins.

<<<BEGIN DEMO-VIDEO SCRIPT SPEC — templates/demo-video-script.spec.md>>>

# SPEC — The Demo Video Script (`script.md`)

> **Status: binding contract.** This file is the single source of truth for what a usable
> hackathon demo-video script is. `src/pgm/engine-prompt.ts` inlines it verbatim into every
> generated `engine-building-prompt.md`, so editing this file changes the deliverable for every
> future hackathon. Do not fork it into a second copy.

## §0 Why this spec exists

The chassis has shipped scripts that could not be used to record a video. Every failure had the
same three root causes, and every rule below exists to kill one of them:

1. **Authored from the plan, not from the product.** The script described step names, latencies and
   savings that the shipped build never had. A judge who watches the video and then opens the repo
   sees a mismatch — which is worse than a plain video.
2. **Shaped as a table.** Spoken paragraphs were crammed into markdown table cells. Nobody can read
   a paragraph out of a table cell while driving a screen recording.
3. **Never measured against the clock.** The text ran minutes over the cap, so it got improvised on
   the day, and the improvisation dropped exactly the sponsor-track evidence that scores points.

A script is usable when the operator can put it on a second monitor, read it top to bottom at a
natural pace, and have every sentence be true of what is on screen.

---

## §1 Non-negotiables

1. **Every fact is measured, never inferred.** Any number, id, entity name, filename, dollar figure
   or latency in the spoken text must come from an actual execution of the built product against
   the shipped demo data. §5 is the procedure. If it was not measured, it does not go in the script.
2. **Prose, not tables.** Spoken text lives in normal paragraphs under a section heading. Tables are
   for the delivery budget and the fact ledger only — never for words that get read aloud.
3. **The clock is a hard constraint.** Every section carries a measured word count and its duration
   at 150 wpm. The total must land under the event's cap with deliberate headroom (§2).
4. **It must sound like a person.** §4 governs. Fragments glued together are a failure, not a style.
5. **The sponsor/side track is the spine, not a mention.** §7 governs.
6. **Never promise a frame that does not exist.** §6 governs.
7. **It ships with its slides.** §9 governs — content plus copy-paste image-generation prompts.

---

## §2 Runtime budget — derive it, do not assume it

1. Read the cap from, in precedence order: `event_profile.json` → `video_limits.max_minutes`; then
   `design_documents/hackathon_brief.md` §4 (Hackathon Rules / Requirements / Tracks); then the live
   hackathon page. **Quote the rule verbatim in the script header**, e.g. *"≤3 minutes (only the
   first 3 minutes are evaluated)"*.
2. Note any judging quirk that changes the shape: an "only the first N minutes are evaluated" rule
   means the close must land before N, not at N. A "must include footage of the project functioning"
   rule means the live-demo section is mandatory and cannot be replaced by slides.
3. **Target 90–95% of the cap in speech**, and state the remaining seconds as deliberate headroom
   for pauses. A 3:00 cap means ~2:40–2:50 of speech. Overrunning the cap is a submission failure;
   underrunning by 20 seconds costs nothing.
4. Convert to words: **words ≈ seconds × 2.5** (150 wpm). This is the budget every section obeys.

---

## §3 Sectioning

Split into 4–6 sections. Each gets: an `mm:ss – mm:ss` window, a title, a visual direction, the
spoken text, and its measured word count. The default four, scaled to the cap:

| # | Section | Share of runtime | Job |
|---|---|---|---|
| 1 | Hook + problem | ~18% | Make a specific person's pain concrete. Name them. One number that hurts. |
| 2 | Solution + architecture | ~30% | What it is, and why this stack — sponsor track front and centre. |
| 3 | Live demo | ~35% | The product actually running, on real demo data, with measured outputs. |
| 4 | Impact + close | ~17% | The measured delta, the stack named once more, stop. |

Rules:

- **The live-demo section is the largest.** If the total is under 3 minutes, cut section 2 before
  section 3.
- Sections 1 and 4 are where slides go (§9); sections 2 and 3 are screen recording.
- Longer caps (5+ minutes) add a section between 3 and 4 — a second demo pass showing depth
  (error/degraded handling, a second use case, or the data model) — never by padding the others.
- If the run is slower than its window, say so in the visual direction and give the fix
  (*"speed up steps 1–3 to ~2×, play step 4 onward at 1×"*). Never let the voiceover drift out of
  sync with the recording.

---

## §4 The spoken text must sound like a person

Write it to be **read aloud**, then read it aloud and fix what makes you stumble.

**Do:**

- Full sentences with a subject and a verb. Vary their length — a long one, then a short one.
- Contractions. "It doesn't scale" beats "It does not scale."
- One idea per sentence. Land it, then move on.
- Say numbers the way a person says them: write "twelve fifty-two", not "$1252.00", when it is read
  aloud. Keep the exact figure in the fact ledger.
- Signpost what the viewer is about to see: "Watch step four." "Here's the payoff."
- Name the specific person from the problem framing. Not "users" — the actual persona.

**Do not:**

- Glue fragments together with dashes and slashes. *"Deterministic multi-step agent — tool
  isolation — MergeTree ORDER BY — sub-100ms p95"* is unreadable and unsayable.
- Stack more than two proper nouns in a sentence. Product names are speed bumps.
- Read out identifiers a listener cannot parse — schema names, snake_case function names, UUIDs.
  Show them on screen instead, and refer to them in words.
- Use marketing verbs (revolutionise, seamless, unlock, empower) or exclamation marks.
- Write anything you would not say to a colleague at a whiteboard.

**Checks:** no sentence over ~25 words. No paragraph over ~60. If a sentence needs a comma-spliced
list of three technologies, split it.

---

## §5 Measure first — the fact-harvest procedure

This is the work unit that must run **before a single line of spoken text is written**, and it runs
**after the product is built** — never against the plan.

1. **Pick the exact demo parameters** the video will use (dataset, filters, ranges, caps). Write
   them down; they are part of the script header.
2. **Execute the real product end to end with those exact parameters.** Prefer the real entry point
   the video shows. Capture: every headline output value, the entities the script will name, and the
   wall-clock duration of the run.
3. **Run it a second time, unchanged.** Compare. If the headline numbers differ, the script may not
   quote them as facts — either fix the nondeterminism, or quote a range and say it is a range.
   Record which it was.
4. **Pick the featured entity** — the single record the demo zooms into — from the *measured* output,
   not from the plan or the seed data. Capture every field the script will mention, plus the
   downstream artefacts it produces.
5. **Distinguish measured from modelled.** If a figure is a constant the code assigns (a scoring
   weight, an assumed hourly rate, a per-incident cost), it is **not** a measurement. Say the
   qualifying word out loud in the script ("modelled exposure", "estimated"), and label it in the
   ledger. Research-sourced business figures (hours saved, industry costs) are assumptions —
   label them and cite where they came from.
6. **Write the Fact Ledger** into the script (§8). Every spoken claim gets a row: the claim, the real
   value, and the source (file, field, or command). A judge's question must be answerable from it.

**The most common failure this prevents:** a bare rule/scoring engine queried in isolation returns
different results than the full pipeline, because the pipeline loads or derives data first. Always
measure the **full path** the demo actually runs.

---

## §6 Screen-reality check

Before writing the visual directions, confirm what the UI actually renders in each beat.

1. For each thing the script says the viewer will see, find the code that renders it. If it is not
   rendered, either change the direction or add a cutaway (terminal, log tail, database query,
   dashboard) that does show it.
2. Check truncation. Previews are often clipped; a "look at the query" beat is worthless if the UI
   shows only the first N characters.
3. List, in a Production Notes section, what each step of the run actually prints on screen, so the
   voiceover matches the recording beat for beat.
4. Where a one-line code change would materially improve the strongest frame, note it as an
   **optional** suggestion with the file and line — do not silently change the product from within
   the script task.

---

## §7 Judging axes and the sponsor track

1. **Read the judging criteria** from `event_profile.json` / `hackathon_brief.md` §4. Every axis must
   be evidenced by at least one specific sentence of spoken text — not a claim that the project is
   good, but a demonstrated fact. Include a coverage table in the script mapping axis → the sentence
   that earns it.
2. **The chosen side/sponsor track is the spine of section 3.** The sponsor's product must be shown
   doing something the project genuinely depends on, and the voiceover must name it at the moment it
   is on screen. A logo, a README mention, or "we also use X" scores nothing.
3. **State the track by name, out loud, once** — early, so a track judge knows within the first
   minute that this entry is theirs.
4. **Show the runtime proof.** If the track requires the product to *use* the sponsor at runtime,
   the video must contain the frame that proves it: the live query, the log line, the trace, the
   written record. If the UI does not surface it, §6 applies — find the cutaway.
5. **One track, argued deeply.** Do not spend spoken seconds on secondary integrations; depth in the
   chosen track beats breadth every time.
6. Mandatory-technology requirements (a required model, framework or platform) get one clear
   sentence naming them, because Stage-One screening looks for exactly that.

---

## §8 Required file shape

**Output path — outside the entry repository.** Write to
`../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md`.

The entry repo is what the organizers receive, and it must contain only the application and the few
documents the rules require. The script is a production aid for the operator, so it lives beside the
event's other working files in the chassis' `hackathon-projects/<project>/` folder. If the chassis
SCRIPT module left a `script.md` stub in that folder, leave it — it points here.

Sections, in this order:

1. **Header** — project, track, cap quoted verbatim from the rules, target speech time, one-line
   theme.
2. **Fact-check status** — the date measured, the exact parameters, and whether the two runs agreed.
3. **Delivery budget** — the section table: window, measured words, speech duration, running total,
   and where the headroom goes.
4. **The sections themselves** — for each: `## [mm:ss – mm:ss] Title`, a `**[Visual: …]**` direction,
   the spoken text as prose, and a `*(N words — m:ss)*` marker.
5. **Fact Ledger** — §5.6. Sub-tables: headline run numbers, the featured entity, the dataset, and a
   clearly separated block for assumptions/modelled figures.
6. **Judging-axis coverage** — §7.1.
7. **Corrections applied** — when revising an earlier draft, a table of *previous claim → why it was
   wrong → what replaced it*. This is how the operator learns to trust the new version.
8. **Production notes** — §6.3, plus recording settings the event's rules require (resolution,
   captions, length, upload target).
9. **Graphical assets** — §9.

**Word counts must be counted, not estimated.** Count the words in each spoken block and put the
real number in the marker and the budget table.

---

## §9 Slides and their image prompts

Two slides, unless the runtime cap justifies more: **slide 1 = the problem, slide 2 = the solution
and the measured impact.** They cover the sections where there is nothing useful to screen-record.

For each slide, the script must contain:

- **(a) Slide text** — the exact words for the slide, ready to paste into the slide tool as real text
  boxes. Keep it to a headline plus 3–6 short lines or a small comparison table.
- **(b) Image prompts** — one hero visual and one supporting visual, each a complete prompt the
  operator pastes into Gemini. Prompts must specify: layout, what each element is, the palette (use
  the entry's own UI colours so slides and footage match), and an explicit list of the only text
  labels allowed in the image.
- **(c) A single-shot alternative** — one prompt that produces the whole slide as one infographic,
  for an operator who does not want to assemble it.

**Rules for the prompts:**

- Put a **shared style block** at the top of the section — style, palette with hex codes,
  typography, and a "no stock photos / no 3D / no clip-art" exclusion list — and tell the operator to
  paste it before each prompt. Consistency between the two slides matters more than either one.
- **Minimise embedded text.** Image models still misspell small labels, and a typo in a slide reads
  as carelessness. Restrict each prompt to a handful of short uppercase labels and end the prompt
  with a sentence naming exactly which labels are permitted.
- Make the **visual metaphor carry the argument**: slide 1 should look congested and manual, slide 2
  clean and linear. The contrast between the two images is the point.
- Slide 2's numbers come from the Fact Ledger, and the script must warn that re-shooting with
  different parameters invalidates them.
- Finish with a short production checklist (spellcheck the generated labels, palette matches the
  footage, measured vs assumed figures visually distinguished, any required disclosure watermark).

---

## §10 Acceptance checks

The script is done when all of these pass:

- [ ] Every number, id and name in spoken text appears in the Fact Ledger with a source.
- [ ] Both measurement runs agreed, or the script quotes a range and says so.
- [ ] Word counts are counted; total speech is under the cap with stated headroom.
- [ ] Read aloud start to finish without stumbling, in under the cap, on a clock.
- [ ] Every judging axis has a named sentence; the track is stated by name and proven on screen.
- [ ] Every visual direction names a frame that exists (or a cutaway that does).
- [ ] Modelled/assumed figures are labelled as such, in the script and out loud.
- [ ] Two slides specified with text, image prompts, shared style block, and a checklist.
- [ ] No spoken sentence exceeds ~25 words; no fragment-chains; no unpronounceable identifiers.

<<<END DEMO-VIDEO SCRIPT SPEC>>>

## §6 This event's derived parameters

Applying §5's §2 and §3 to this event, so the implementor does not have to re-derive them:

**The cap.** `event_profile.json` for this event was written with every field set to
`"not extracted — confirm manually"`, so the binding source is `design_documents/hackathon_brief.md`
§4, which quotes the rule verbatim:

> "Include a video (**maximum 5 minutes**) … Demonstration of your working project … Pitch … must
> cover: (1) the problem you're solving (2) who it's for (3) why it matters … Slides, screen
> recordings, and voiceover are all acceptable — you do not need to appear on camera. … Videos must
> be uploaded to YouTube or Vimeo and made public."

Quote that in the script header. There is **no** "only the first N minutes are evaluated" rule for
this event, so the close may land near the cap — but the demonstration of the working project is
mandatory and cannot be replaced by slides.

**The budget.** 5:00 cap → target 4:40 of speech (93%), 20 seconds of deliberate headroom for
pauses. 280 seconds × 2.5 = **about 700 words total**. Five sections, because a 5-minute cap earns
the depth section §5's §3 describes:

| # | Section | Window | Target words |
|---|---|---|---|
| 1 | Hook + problem | 0:00 – 0:45 | ~112 |
| 2 | Solution + architecture | 0:45 – 2:00 | ~187 |
| 3 | Live demo | 2:00 – 3:35 | ~237 |
| 4 | Depth: what happens when Bedrock is down, and the audit trail | 3:35 – 4:10 | ~87 |
| 5 | Impact + close | 4:10 – 4:40 | ~75 |

Sections 1 and 5 are slides; 2, 3 and 4 are screen recording. Section 3 is the largest, and its
spine is the Professional Agents track: a solo host doing skilled work, made dramatically better at
it.

**The track sentence.** State `Professional Agents` out loud inside the first minute, in section 1
or the opening of section 2.

**The mandatory-technology sentence.** One clear sentence naming **Strands Agents SDK** and
**Amazon Bedrock**, in section 2, spoken while the architecture diagram or the tool-call stream is
on screen. Stage-One screening looks for exactly this.

**The palette for the slides.** Read the hex values from `src/platform/ui/tokens.css` and
`src/platform/ui/themes/operator.css` — the theme the app ships — so the slides and the footage
match. Do not invent colours.

## §7 Failure modes

| Failure | What degrades | What the operator sees |
|---|---|---|
| The golden cache was never recorded | there is nothing real to quote; drafts are fallback text | WU-01 detects it (`source` is `none`, not `cache` or `live`) and this plan stops with that finding |
| The two runs disagree on a headline number | that number cannot be stated as a fact | the script quotes a range and says it is a range, per §5's §5.3; the likely culprit is named in §8 WU-01 step 6 |
| `PUBLIC_URL` does not exist | the "it's live, try it" beat | the script's visual direction uses `localhost:8080` instead and the header records that the live link was not shipped |
| A visual direction names a frame the UI does not render | the recording drifts from the voiceover | §5's §6 requires checking each beat against `src/stayquiet/web/*.tsx` and DP-UI §5.6's copy table before writing directions |
| The read-aloud test overruns 5:00 | submission failure | WU-03's word-count check is the runnable gate; cut section 2 before section 3 |

## §8 Work units

### WU-SCRIPT-01 — Harvest the facts (runs before a single spoken line is written)

**Goal.** Execute the built product twice with the exact demo parameters the video will use, and
write down every number the script may quote.

**Demo parameters — these exact values, written into the script header.**

* Entry point: `python -m src.stayquiet` on port 8080, then the browser at `/`.
* Dataset: the committed fixtures — `fixtures/synthetic/bookings.json` (6 bookings) and the two
  captures `2026-08-01` and `2026-09-08`.
* Caps: `max_bookings` 6 from `config/stayquiet.json`; `thread_token_budget` 900.
* Cycle interval for recording: `STAYQUIET_CYCLE_INTERVAL_S=30`.
* Two modes measured: **live** (AWS credentials present, no `STAYQUIET_DEMO_MODE`) and **offline**
  (`STAYQUIET_DEMO_MODE=1`).

**Steps.**
1. Run the harvest command below. It executes the full cycle **twice live** and once offline, and
   prints a comparable block for each.
2. Record, for each live run: `bookings_scanned`, `bookings_affected`, `changed_clauses`,
   the three decision kinds and their `modelled_exposure_eur`, `quiet_actions`, `tool_calls`,
   `tokens`, `estimated_cost_usd`, and `elapsed_ms`.
3. Compare run 1 with run 2. The deterministic fields (`bookings_scanned`, `bookings_affected`,
   `changed_clauses`, the decision kinds, the exposures, `quiet_actions`) MUST match. If they do
   not, stop and report — the cause is almost certainly the money-amount safety net described in
   DP-AGENT §5.5 rule 4, which is the only model-dependent branch in the triage gate.
4. The non-deterministic fields (`tokens`, `elapsed_ms`, the draft wording, `tool_calls` length) may
   differ. For each of those the script quotes, write a **range** and say it is a range.
5. Choose the featured entity from the *measured* output, not from the fixtures. Use **BK-1044,
   Anneli Virtanen at Harbour Studio** unless the measured output contradicts it: it is the
   refund decision, it is the clearest single beat, and its modelled exposure is the largest
   single figure. Capture: the guest's question, the clause that changed and both its texts, the
   drafted reply verbatim, and the audit lines it produced.
6. Capture the offline run's `elapsed_ms` separately — that is the "with Bedrock unavailable" figure
   section 4 quotes.
7. Capture the on-screen truth for each beat: run the app, open `/`, and write down what each step
   label actually reads (`src/stayquiet/web/labels.ts`) and what the decision card actually shows
   (DP-UI §5.6). This is §5's §6 screen-reality check.

**Files created.** none in the repository. Keep the harvest output in the scratch area or paste it
straight into the ledger.

**Verification command.**
```bash
python - <<'EOF'
import json, os, time
from engine.agents import run_cycle
from src.stayquiet.model import cost_snapshot

def harvest(label):
    t0 = time.time()
    r = run_cycle()
    return {
        "label": label,
        "scanned": r["bookings_scanned"],
        "affected": r["bookings_affected"],
        "changed": r["changed_clauses"],
        "kinds": [d["kind"] for d in r["decisions"]],
        "exposure": [d["modelled_exposure_eur"] for d in r["decisions"]],
        "quiet": r["quiet_actions"],
        "tool_calls": r["tool_calls"],
        "tokens": r["tokens"],
        "cost_usd": r["cost"]["estimated_cost_usd"],
        "elapsed_ms": r["elapsed_ms"],
        "wall_s": round(time.time() - t0, 1),
        "sources": sorted({d["source"] for d in r["drafts"]}),
        "featured": next((d for d in r["decisions"] if d["booking_id"] == "BK-1044"), None),
    }

runs = [harvest("live-1"), harvest("live-2")]
os.environ["STAYQUIET_DEMO_MODE"] = "1"
import importlib, src.stayquiet.config as cfgmod
cfgmod._cached = None
runs.append(harvest("offline"))

for r in runs:
    f = r.pop("featured")
    print(json.dumps(r, indent=2))
    if r["label"] == "live-1" and f:
        print("FEATURED:", f["booking_id"], f["kind"], f["modelled_exposure_eur"])
        print("DRAFT:", f["draft_text"])
det = ("scanned", "affected", "changed", "kinds", "exposure", "quiet")
print("DETERMINISTIC MATCH:", all(runs[0][k] == runs[1][k] for k in det))
EOF
```
**Expected output.** Three JSON blocks, the featured booking's kind and draft, and as the last line:
```
DETERMINISTIC MATCH: True
```
with `live-1` and `live-2` both showing `"scanned": 6`, `"affected": 4`,
`"kinds": ["exception", "refund", "review_risk"]`,
`"exposure": [306.0, 395.0, 263.0]`, `"quiet": 1`, `"sources": ["live"]`, and the `offline` block
showing `"sources": ["cache"]` with a smaller `wall_s`.

**What it proves.** Every figure the script may quote came from two real executions of the built
product, the deterministic ones agree between runs, and the offline path really serves recorded
answers — which is exactly what §5's §5 demands before a word is written.

> If `DETERMINISTIC MATCH` is `False`, or `sources` is `["none"]`, do not proceed to WU-02. Report
> the discrepancy: the script cannot be written from an unstable or empty measurement.

---

### WU-SCRIPT-02 — Write the script

**Goal.** The file, in the nine-section shape of §5's §8, from the harvested facts only.

**Steps.**
1. Create `../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md`.
   If a `script.md` stub already exists in that folder, leave it and add one line at its top saying
   this file supersedes it.
2. Write the nine sections in order (§5 §8). Use §6's budget table as the section plan and §6's
   verbatim cap quote in the header.
3. Write the spoken text as prose paragraphs under each section heading — never in a table
   (§5 §1.2). Obey §5 §4: contractions, one idea per sentence, nothing over about 25 words, no
   stacked proper nouns, no `snake_case` read aloud. Say "booking ten forty-four", not "BK-1044".
4. Name **Anneli Virtanen** — the featured guest — and the host she is writing to. Do not say
   "users".
5. Say `Professional Agents` out loud in the first minute. Say `Strands Agents SDK` and
   `Amazon Bedrock` in one clear sentence in section 2.
6. Label every modelled figure out loud: "modelled exposure", "estimated cost". The three exposure
   figures and the dollar cost are all modelled — they come from constants in
   `config/stayquiet.json`, not from a bill.
7. Fill the Fact Ledger with one row per spoken claim: the claim, the measured value, and the
   source (the command from WU-01, the fixture file and field, or the config key). Put the modelled
   and assumed figures in a clearly separated block.
8. Fill the judging-axis coverage table with one named sentence per axis from blueprint §0.3:
   * Technical Implementation — the sentence naming the SDK and Bedrock over the tool-call stream.
   * Design — the sentence about the quiet state being the default and there being no chat box.
   * Potential Impact — the sentence with the host's per-booking time cost and the measured
     four-of-six figure.
   * Creativity & Originality — the sentence about a model never being the reason a refund is
     escalated.
   * Presentation — the close, which restates problem, who and why in three clauses.
9. Write the Production Notes: what each step actually prints on screen, the recording settings
   (1080p or better, public YouTube, under five minutes), the pace fix if the live run is slower
   than its window, and any **optional** one-line product improvement with its file and line —
   noted, not applied.
10. Write the Graphical assets section per §5 §9: the shared style block with hex codes read from
    `src/platform/ui/tokens.css` and `themes/operator.css`, slide 1 (the problem — congested,
    manual), slide 2 (the solution and the measured impact — clean, linear), each with slide text,
    a hero prompt, a supporting prompt, a single-shot alternative, and the permitted-labels
    sentence. Finish with the production checklist.
11. If a previous draft of this file existed, fill the "Corrections applied" table; if this is the
    first, write one line saying so.

**Files created.** the script, outside the entry repository.

**Verification command.**
```bash
python -c "
import pathlib, re
p = pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md')
t = p.read_text(encoding='utf-8')
need = ['Fact Ledger','Judging-axis coverage','Production notes','Graphical assets',
        'Delivery budget','Fact-check status','Corrections applied',
        'Professional Agents','Strands Agents','Amazon Bedrock','maximum 5 minutes',
        'Anneli Virtanen','modelled']
print('missing', [n for n in need if n not in t] or 'none')
print('sections', len(re.findall(r'^## \[\d\d:\d\d', t, re.M)))
print('markers', len(re.findall(r'\*\(\d+ words', t)))
print('visuals', len(re.findall(r'\*\*\[Visual', t)))
print('in-repo', pathlib.Path('demo-video-script.md').exists())
"
```
**Expected output.**
```
missing none
sections 5
markers 5
visuals 5
in-repo False
```
**What it proves.** All nine required sections are present, all five spoken sections carry a
window, a visual direction and a counted word marker, the track and the mandated technologies are
named, the featured guest is named, modelled figures are labelled, and the file is outside the entry
repository.

---

### WU-SCRIPT-03 — Acceptance checks, with the clock as the gate

**Goal.** Run every check in §5 §10 and prove the script fits the cap.

**Steps.**
1. Work through §5 §10's nine checkboxes and record each one's result in the run report.
2. Read the script aloud, start to finish, on a clock. Record the actual time. If it exceeds 4:50,
   cut words from section 2 first, then section 5 — never from section 3, and never from the
   sentences named in the judging-axis coverage table.
3. Re-count the word markers after any cut, so the numbers in the markers and the budget table are
   counted rather than estimated.
4. Confirm every number in the spoken text appears in the Fact Ledger with a source. Grep for digits
   in the spoken paragraphs and check each hit against the ledger.

**Files modified.** the script only.

**Verification command.**
```bash
python - <<'EOF'
import pathlib, re
p = pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md')
t = p.read_text(encoding='utf-8')
declared = [int(m) for m in re.findall(r'\*\((\d+) words', t)]
total = sum(declared)
secs = total / 2.5
# spoken blocks = paragraphs between a [Visual: …] line and the word-count marker
blocks = re.findall(r'\*\*\[Visual[^\n]*\n+(.*?)\*\(\d+ words', t, re.S)
counted = [len(b.split()) for b in blocks]
long_sentences = [s.strip()[:60] for b in blocks for s in re.split(r'(?<=[.!?])\s+', b)
                  if len(s.split()) > 25]
print('sections', len(declared), 'declared_total', total)
print('counted_total', sum(counted))
print('counts_match', all(abs(a - b) <= 3 for a, b in zip(declared, counted)))
print('speech_mmss', f"{int(secs // 60)}:{int(secs % 60):02d}")
print('under_cap', secs <= 285)
print('long_sentences', long_sentences or 'none')
EOF
```
**Expected output.**
```
sections 5 declared_total <between 660 and 720>
counted_total <within 3 per section of declared_total>
counts_match True
speech_mmss 4:3x or 4:4x
under_cap True
speech under 4:45 with 15+ seconds of headroom below the 5:00 cap
long_sentences none
```
(The last descriptive line is not printed by the command; it is the standard the printed values must
meet: `under_cap True`, `counts_match True`, `long_sentences none`.)

**What it proves.** The word counts in the script are real counts rather than estimates, the total
speech lands under the five-minute cap with deliberate headroom, and no spoken sentence is too long
to read aloud — the three failures §5 §0 exists to prevent.

---

## §9 Verification summary

```bash
# WU-SCRIPT-01 — harvest (see §8 for the full heredoc; it must print DETERMINISTIC MATCH: True)
# WU-SCRIPT-02
python -c "
import pathlib, re
p=pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md')
t=p.read_text(encoding='utf-8')
need=['Fact Ledger','Judging-axis coverage','Production notes','Graphical assets','Delivery budget',
      'Fact-check status','Corrections applied','Professional Agents','Strands Agents','Amazon Bedrock',
      'maximum 5 minutes','Anneli Virtanen','modelled']
print('missing', [n for n in need if n not in t] or 'none')
print('sections', len(re.findall(r'^## \[\d\d:\d\d', t, re.M)))
print('markers', len(re.findall(r'\*\(\d+ words', t)))
print('visuals', len(re.findall(r'\*\*\[Visual', t)))
print('in-repo', pathlib.Path('demo-video-script.md').exists())"
# WU-SCRIPT-03 — the word-count gate (full heredoc in §8)
```

## §10 Risks

| Risk | Mitigation |
|---|---|
| The script is written from this plan instead of the product | WU-01 is a hard gate: WU-02 may not start until `DETERMINISTIC MATCH: True` and `sources: ["live"]` have been seen |
| A quoted number turns out to be a constant, not a measurement | §8 WU-02 step 6 names every modelled figure in this product — the three exposures and the dollar cost — and requires the qualifying word out loud |
| The video overruns five minutes and is disqualified | WU-03's word-count command is the runnable gate, targeting 4:40 with 20 seconds of headroom, and it names what to cut first |
| Spoken text is trapped in a table | §5 §1.2 forbids it and WU-02 step 3 repeats it; WU-03's checker extracts prose blocks between the visual direction and the marker, so a table would yield zero counted words |
| A visual direction promises a frame that does not exist | WU-01 step 7 captures what each beat actually renders, from `labels.ts` and DP-UI §5.6, before any direction is written |
| The track judge does not realise the entry is theirs | `Professional Agents` is spoken inside the first minute (WU-02 step 5) and asserted by WU-02's check |
| The script edits the product to make a nicer frame | §2's one exception is explicit: note it as optional with file and line, do not apply it |
| The script lands inside the entry repository | the output path is outside it, and both WU-02 and WU-03 assert `in-repo False` |
