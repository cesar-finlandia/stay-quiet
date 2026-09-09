# TASK — Generate the Master Blueprint + Design Plans for this hackathon entry

You are a principal engineer preparing a hackathon entry for implementation by
**low-intelligence AI models** driven by `run_sweep.sh --planner` and
`run_sweep.sh --sequence`. Your job: read the material below, then produce ONE
Master Blueprint plus a set of chassis-format design plans that those sweeps will
implement verbatim. The goal is simple and absolute: **maximize the probability
of winning the grand prize AND at least one side-track prize**.

> Execute this prompt with the entry repository root as the working directory
> (`../hackathon-entries/2026-09-agents_for_humans`). Local `design_documents/...` paths resolve
> inside this entry repo (copied here at assembly time); `../../hackathons/...`
> paths resolve into the sibling chassis repo.

## READ FIRST (in this order)

1. `design_documents/winning_project_plan.md` — the selected idea, architecture spec,
   and suggested module emphasis (entry-local copy of `hackathon-projects/2026-09-agents_for_humans/winning_project_plan.md`). This is the source of truth for WHAT we build.
2. `design_documents/proposal.json` — Component Advisor output: which chassis modules
   were selected/excluded and why (entry-local copy of `hackathon-projects/2026-09-agents_for_humans/proposal.json`). If it is absent, read
   `../../hackathons/contracts/component-catalog.json` and assume all twelve components with the
   advisor's minimal-viable defaults.
3. `../../hackathons/contracts/component-catalog.json` — what each selected chassis module
   already provides (do NOT redesign chassis behavior; compose it).
4. The chassis design plan for EACH selected module. Mapping (module → plans in
   `../../hackathons/design_documents/design_plans/`):

   | module | design plan(s) |
   |---|---|
   | resilience | DP-A-resilience-layer.md |
   | platform | DP-B-platform-layer.md |
   | ideation | DP-D1-ideation-hour0.md, DP-D2a-deckgen-script.md, DP-D2b-demodrive-faqdef.md |
   | context | DP-E-context-buffer-manager.md |
   | data | DP-H-synthetic-demo-data-generator.md |
   | cost | DP-I-cost-usage-guardrail.md |
   | provenance | DP-J-provenance-disclosure-toolkit.md |
   The table is pre-filtered to the modules marked included:true in design_documents/proposal.json (entry-local copy of hackathon-projects/2026-09-agents_for_humans/proposal.json; legacy private/pgm/proposal.json is deprecated).
   Read ONLY the rows whose module is included:true in `design_documents/proposal.json`;
   skip excluded modules entirely — never design against a module the manifest excludes.
   **Precedence rule: if this prompt's enumerations conflict with
   `design_documents/proposal.json`, the manifest wins.**
   Your plans must CALL INTO these modules, never re-implement them.
5. `../../hackathons/design_documents/lablab_hackathon_strategy_blueprint.md` — §5 (rules
   confirmations) and §7 (the per-hackathon playbook you are automating).
  6. `../../hackathons/hackathon-projects/2026-09-agents_for_humans/event_profile.json` or the event profile wherever
     the Event Profile Extractor wrote it (legacy preparing/exercise-1/work/ is deprecated) — mandated platform, sponsor tracks,
     judging criteria, submission rules, deadlines. When absent, fall back to
     `design_documents/hackathon_brief.md` as the source for tracks, criteria, and deadlines.

## MANDATORY COMPLIANCE — DISQUALIFICATION-LEVEL (extract before any design)
Before drafting any blueprint section, scan `design_documents/winning_project_plan.md` + its
source `design_documents/hackathon_brief.md` (§4 Hackathon Rules - Requirements - Tracks) and the live *Hackathon-page* for verbatim:
- MANDATORY TECHNOLOGIES: whatever the brief's §4 lists as "Every project must use" / "Required developer tools" / "What to Build" — copy the exact SDK/API/platform names verbatim (e.g. for this brief it may be WebMCP `document.modelContext.registerTool`, or Gemini + Google Cloud Agent Builder, or AssemblyAI Voice API — never invent, never hardcode a stack not in the brief).
- PRIZE TRACKS: whatever the brief's Tracks/Prizes section lists — copy track names/table exactly (e.g. WebMCP Challenge Top 10, or IBM/Grafana/Parallel/ClickHouse/Replit partner tracks, or lablab's Taskmaster/Collaborative Partner/Fortified Enterprise Fleet) + judging axes/weights if published.
- SUBMISSION GATE: whatever the brief's Submission Requirements lists — copy exact fields verbatim (hosted URL, public repo + spin-up guide, license file, architecture diagram, video length + proof requirements as published — e.g. <3min YouTube for WebMCP, or 3-min trailer for Agentic Cinema, or 4-min GCP-proof video for lablab).
- BONUS (if any): only if the brief explicitly lists bonus integrations/points (e.g. Gemma/Veo/Lyria, blog/social) — otherwise state "no bonus — not worth track dilution".
These are Stage-One pass/fail — a missing mandatory tech = disqualified regardless of idea quality. Therefore:
- §1 Requirements MUST trace each mandatory tech from the brief to a winning-plan section and to a Judging axis (e.g. if brief mandates WebMCP then "WebMCP registerTool → WebMCP Leverage"; if mandates Gemini+ADK+GCP then "Gemini 3.5 Flash via Vertex AI → Innovation; ADK tool isolation → Architectural Discipline; Cloud Run + Firestore + video proof → Demo").
- §2 Architecture MUST name the chosen mandatory stack per the brief (model name + call method if LLM, agent framework if any, infra/deploy service with deploy command and video capture plan as the brief requires) and diagram wiring. Do not hardcode Gemini/ADK/Cloud Run when the brief mandates a different stack (e.g. WebMCP on Vercel).
- §3 Design-plan map MUST allocate a work unit to each mandatory proof artifact (deploy, diagram, video GCP segment, spin-up).
- sponsor_tracks choice must be justified as the highest win-probability track for this idea — not "empty" when brief names tracks.
- Bonus integrations are opt-in only: include Gemma/Veo/Lyria only when Stage Three bonus outweighs dilution; otherwise explicitly state "no bonus integration".

## DELIVERABLES (exact paths) — exactly TWO kinds of artifact, nothing else

You write the Master Blueprint **and every design plan** in THIS run. There are no
intermediate prompt files and no sequential-authoring config: the next thing that happens
after this chat is implementation.

1. `design_documents/master_blueprint_entry.md` — the entry's master
    blueprint:
    - §1 Requirements: functional + non-functional, each traced back to
      winning_project_plan.md sections and event judging criteria.
    - §2 Architecture: components, data flow, envelope/transport wiring from
      engine to the assembled UI (EventEnvelope shape, useEventStream()), plus
      an explicit inter-module contract table: every cross-module function/type/file
      is owned by exactly one module — with file path, export name, and
      input/output shape — so consumers know what to import and never re-implement
      or stub it.
    - §3 Design-plan map: EVERY design plan needed to build the entry — one row
      per plan with id (`DP-<TOPIC>`), title, scope boundaries, the interfaces
      it owns (inputs/outputs/paths), its consumers, its dependencies on other plans,
      and the requirements each of its work units must fulfill. This map together
      with §2 is the single binding contract between all the plans you then write.
    - §3a Inter-module boundary rule (why §2+§3 must be in-depth): §2+§3 are what
      keep the plans consistent with one another. If they are vague, one plan will
      expose foo() while another independently creates its own foo() or stub and
      neither is used — resulting in disconnected, duplicate implementations. So
      §2+§3 must be exhaustive: every provider-consumer pair is named once, with
      owning module, file, export, and shape, so plans import rather than duplicate.
    - §3b **DP-SCRIPT is mandatory.** The §3 map MUST contain a plan whose sole
      deliverable is the demo-video script, and it MUST be the LAST plan in the
      map. Its work units run only after the product is built, because its first
      work unit executes the real product to harvest measured facts. Its
      requirements are fixed by the DEMO-VIDEO SCRIPT CONTRACT section below —
      write that contract into `design_documents/design_plans/DP-SCRIPT.md`
      itself, so the implementor has it without reading any other file. Single
      owner: NO other plan may author the demo-video script. A demo/packaging plan
      may record, edit and upload the video, but the words come from DP-SCRIPT — a
      plan that writes a script before the product runs is how every previous entry
      got an unusable one.
    - §4 Submission checklist mapping: deployed public URL, public repo,
      disclosure doc, deck/demo — which design plan produces which. The
      demonstration video's script is produced by DP-SCRIPT (§3b).
    - §5 Risks + degraded-demo fallback ladder.
2. `design_documents/design_plans/DP-<TOPIC>.md` — ONE file per plan listed in
   the §3 map, all of them written here, in §3 order. Each one is the COMPLETE,
   fully defined, chassis-format design plan: the implementor opens exactly this
   one file and the code it names — never the blueprint, never another plan.

   Required shape, in this order:

   - `# DP-<TOPIC> — <title>`
   - **§0 Context & blockers** — what must already exist before WU-01 runs.
   - **§1 Purpose & requirement IDs** — traced to blueprint §1.
   - **§2 Scope boundaries** — an IN list (exactly the files this plan creates,
     no others) and an OUT list (files owned elsewhere, each naming its owner).
   - **§3 Interfaces owned** — literal skeletons: full file path, exact export
     names, complete signatures with types, and the literal docstring/header
     comment of each.
   - **§4 Interfaces consumed** — the exact import lines to copy verbatim, each
     naming the plan that owns it.
   - **§5…§N Algorithms** — numbered steps or pseudocode for every non-trivial
     behaviour, plus the literal full text of any prompt / schema / config file
     this plan owns.
   - **§N+1 Failure modes** — what degrades, how, and what the user sees.
   - **§N+2 Work units** — `WU-<TOPIC>-01`, `-02`, … in execution order.
     Each has: Goal, numbered Steps, Files created/modified, ONE runnable
     verification command, its EXACT expected output, and one sentence saying
     what that output proves.
   - **§N+3 Verification summary** — every verification command in order.
   - **§N+4 Risks.**

   Write the plans in dependency order, so that when a plan's §4 names an import,
   the plan that owns it is already written and the names match character for
   character.

**Both artifacts must be finished in this run.** A design plan that says "to be
detailed later", leaves a signature unspecified, or tells the implementor to go read
the blueprint has failed the HARD QUALITY BAR below. If you are running short, cut
scope in §3 — fewer plans, each complete — never detail.

## ENTRY REPOSITORY CONTENTS + SUBMISSION DOCS — binding policy

### What may live in the entry repository

The entry repo is what the organizers clone and judge. It contains **the application and
nothing else**: source code the product needs to run, its tests, its build/deploy config, and
the few documents the rules require.

Allowed at the entry root, and nothing more:

- application source, tests, build and deploy configuration
- `README.md`, `LICENSE`, `disclosure.md`, the hygiene report
- `design_documents/`

**Every production aid goes to `../../hackathons/hackathon-projects/2026-09-agents_for_humans/` instead** —
the pitch deck, the demo-video script, the judge Q&A sheet, capture artifacts, and the
assembly manifest. They help the operator make the submission; they are not part of the
product, and a judge opening the repo should not have to wade through them. When a plan runs
a chassis tool that defaults to writing into the repo root, it MUST pass an explicit output
path into that folder.

### README.md — never mention the shared infrastructure

The README is a product README: what it does, who it is for, how to run it, the track, the
stack, the hosted URL, the licence. It must **not** contain a "prior work"/"scaffolded from"
paragraph, must not name or link any chassis/starter/boilerplate repository, and must not list
which shared directories were copied in. Originality disclosure belongs in
`disclosure.md` — that is the file the rules ask for, and duplicating it in the README
oversells shared plumbing as the substance of the entry.

### disclosure.md — capabilities, not a catalogue

`disclosure.md` is generated; a plan may APPEND event-specific sections (AI usage, data
provenance, runtime proofs) but must not rewrite the generated part or reintroduce what it
deliberately removes. The generated part states, in plain English:

- which pre-existing blocks of code are present, one bullet each, describing **what the code
  does** — never a repository name, never a module id, never a requirement code;
- that all application-level code and most lower-level code was written for this hackathon;
- how the entry was built (design plans authored with Claude AI, implemented with cheaper
  models, tested with Claude).

Any section a plan appends follows the same rule: describe capabilities and state what is new
work. Do not name the shared repository anywhere, and do not enumerate its directories.
Accuracy still wins over brevity — if pre-existing code ships, it is disclosed; the rule
governs *how* it is described, never *whether* it is.

## DEMO-VIDEO SCRIPT CONTRACT — binding requirements for DP-SCRIPT

Nearly every submission is judged from its video before its code. The chassis has repeatedly
produced scripts that could not be recorded, because they were written from the plan before the
product existed. The contract below fixes that; reproduce it inside
`design_documents/design_plans/DP-SCRIPT.md` verbatim, and allocate its §5 fact-harvest
to that plan's FIRST work unit.

DP-SCRIPT's work units must, in order: (1) harvest measured facts by executing the built product
twice with the exact demo parameters the video will use; (2) write
`../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md` to the shape in §8 — OUTSIDE
this entry repo, which ships only the application; (3) verify the acceptance checks in
§10, with the word-count check as its runnable verification command.

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

## HARD QUALITY BAR — the implementor is a LOW-INTELLIGENCE model

Encode this bar into §2+§3 of the blueprint AND into every design plan you write, so
that the implementor cannot infer anything and no two plans duplicate the same
cross-module contract:

- fully define every contract: exact file paths, exported names, function
  signatures, input/output JSON shapes — and for cross-module contracts,
  state owning module, file, export, and all consuming modules (single owner,
  N consumers; consumers MUST import, never re-define or stub);
- spell out every algorithm as numbered steps or pseudocode — no "use judgment",
  no "as appropriate", no unstated defaults;
- every work unit ends with one runnable verification command and its expected
  output (for cross-module work units, the command must exercise the actual
  provider→consumer import);
- if a task genuinely requires higher intelligence, split it until it does not,
  or move that part into a prompt template the runtime LLM call receives.

## CONSTRAINTS

- Engine code lives ONLY inside this repository (the assembled working copy):
  `engine/` stubs marked TODO(ENGINE) plus
  new files under `src/`. NEVER modify the sibling chassis repo's `src/`
  (`../../hackathons/src/`).
- Compose chassis modules via their documented CLIs/APIs; wrap every outbound
  LLM call with `withResilience`; emit progress as EventEnvelopes so the
  platform UI streams it.
- Budget honesty: prefer deterministic code over extra LLM calls; degrade
  gracefully (DegradedResult) instead of crashing mid-demo.

## FINISH

Print the list of generated files (the blueprint + every
`design_documents/design_plans/DP-*.md`) and stop. Do NOT implement anything
yourself — no application source, no engine code; the plans are the product of this run.
