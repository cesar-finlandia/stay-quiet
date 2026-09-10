# DP-SUBMIT — README, architecture diagram, disclosure, submission copy, operator aids

## §0 Context & blockers

Must already exist:

* Every plan from DP-FOUND through DP-DEPLOY, with their verification commands passing.
* `PUBLIC_URL` known (DP-DEPLOY WU-04) — or known to be unavailable, which is also a fact this plan
  records.
* `assembly.manifest.json` at the repository root (present since assembly).

Pre-existing and read-only: `src/provenance/` (the disclosure generator, the submission formatter,
the hygiene guard), `src/ideation/` (deck, Q&A and capture tooling), `contracts/`.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Produce every document the rules ask for, put each one where it belongs, and put nothing else in the
repository a judge clones.

Requirements (blueprint §1): **SQ-F-14** (`README.md`, `LICENSE`, `disclosure.md`, a labelled
architecture diagram, a one-command spin-up), **SQ-N-03** (nothing in the repo is real personal
data, and the documents say so), **SQ-N-07** (the entry repo holds the application and the required
documents only; every production aid is written to
`../../hackathons/hackathon-projects/2026-09-agents_for_humans/`).

## §2 Scope boundaries

### IN — the only files this plan creates, modifies or deletes, inside the repository

1. `README.md` (replace the DP-FOUND placeholder)
2. `docs/architecture.md`
3. `docs/architecture.mmd`
4. `ai_tools.json`
5. `disclosure.md` (generated, then appended to)
6. `hygiene-report.md` (generated)
7. `engine/README.md` (replace wholesale — the assembled version describes shared scaffolding, which
   the README policy forbids anywhere in the repo)
8. Delete: `run_sweep.sh`, `models.json`, `engine/rag/`, `engine/voice/`, `docs/engine-guide.md`

### IN — files this plan creates OUTSIDE the repository

All under `../../hackathons/hackathon-projects/2026-09-agents_for_humans/`:

9. `submission.md` — the Devpost field copy
10. `deck/` — pitch deck skeleton
11. `qa/qa-sheet.md` — judge Q&A defence sheet
12. `builder-post.md` — optional bonus blog draft

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `src/**`, `engine/**` except `engine/README.md` | their own plans |
| `Dockerfile`, `scripts/**`, `deploy/**` | DP-DEPLOY |
| `fixtures/**` | DP-DATA / DP-DEPLOY |
| `.../demo-video-script.md` | **DP-SCRIPT — this plan must not write a single line of the demo-video script** |
| `design_documents/**` | the design process; leave as is |

## §3 Interfaces owned

No code. The contracts are the documents, their locations, and the three generator commands:

| Artifact | Path | Produced by |
|---|---|---|
| Product README | `README.md` | written here, literally (§5.1) |
| Architecture diagram | `docs/architecture.mmd` + `docs/architecture.md` | written here, literally (§5.2) |
| AI-assistance log | `ai_tools.json` | written here, literally (§5.3) |
| Disclosure | `disclosure.md` | `python -m src.provenance.provo.cli generate …` then appended (§5.4) |
| Hygiene report | `hygiene-report.md` | `python -m src.provenance.submit.cli hygiene …` |
| Submission copy | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/submission.md` | `python -m src.provenance.submit.cli format …` then completed by hand (§5.5) |
| Deck | `…/deck/` | `npx vite-node src/ideation/deckgen/cli.ts populate …` |
| Q&A sheet | `…/qa/qa-sheet.md` | `npx vite-node src/ideation/faqdef/cli.ts generate …` |

## §4 Interfaces consumed

Command lines, to copy verbatim. Each `--out` is explicit, because these tools default to writing
into the repository root and the contents policy forbids that for production aids.

```bash
# disclosure (repo document — required by the rules)
python -m src.provenance.provo.cli generate \
  --manifest assembly.manifest.json \
  --ai-log ai_tools.json \
  --config src/provenance/config/disclosure.json \
  --out disclosure.md

# repo hygiene / secret scan (repo document)
python -m src.provenance.submit.cli hygiene \
  --manifest assembly.manifest.json \
  --config src/provenance/config/hygiene.json \
  --out hygiene-report

# submission field copy (production aid — OUTSIDE the repo)
python -m src.provenance.submit.cli format \
  --plan design_documents/winning_project_plan.md \
  --manifest assembly.manifest.json \
  --disclosure disclosure.md \
  --config src/provenance/config/submit.json \
  --out ../../hackathons/hackathon-projects/2026-09-agents_for_humans/submission.md

# pitch deck (production aid — OUTSIDE the repo)
npx vite-node src/ideation/deckgen/cli.ts populate \
  --plan design_documents/winning_project_plan.md \
  --manifest assembly.manifest.json \
  --disclosure disclosure.md \
  --no-llm \
  --out ../../hackathons/hackathon-projects/2026-09-agents_for_humans/deck

# judge Q&A sheet (production aid — OUTSIDE the repo)
npx vite-node src/ideation/faqdef/cli.ts generate \
  --plan design_documents/winning_project_plan.md \
  --manifest assembly.manifest.json \
  --disclosure disclosure.md \
  --out ../../hackathons/hackathon-projects/2026-09-agents_for_humans/qa
```

## §5 Literal document contents

### §5.1 `README.md` — complete file

This is a **product** README. It must not contain a "prior work" or "scaffolded from" paragraph,
must not name or link any starter, chassis or boilerplate repository, and must not list which shared
directories were copied in. Originality disclosure lives in `disclosure.md`, which is the file the
rules ask for.

Replace `<PUBLIC_URL>`, `<REPO_URL>` and `<YOUTUBE_URL>` with the real values before the repository
is made public; if the live URL does not exist, delete that bullet rather than leaving a placeholder.

Amendment 2026-09-10: with no App Runner deployment (DP-DEPLOY WU-04 blocked, no AWS
credentials on the build machine) there is no `<PUBLIC_URL>`, and the video is not
uploaded yet so there is no `<YOUTUBE_URL>` either — both bullets are deleted, not
left as placeholders, and the operator re-adds them at publish time alongside the
real links. (The template has no repo-URL bullet; the origin is
`https://github.com/cesar-finlandia/stay-quiet` for the operator's release step.)

````markdown
# StayQuiet

**A background agent for independent short-stay hosts.** It watches the platform's policy text and
your bookings, drafts what you would have written, and pings you only when a refund, an exception or
a review risk is actually yours to decide.

Built with the **Strands Agents SDK for Python** on **Amazon Bedrock**.
Track: **Professional Agents**.

- Live demo: <PUBLIC_URL>
- Demo video: <YOUTUBE_URL>
- Licence: MIT (see `LICENSE`)

---

## The problem

A solo host with two or three listings wakes up to three overlapping threads: a guest asking to
split a payment the platform now handles differently, a cleaner disputing a checkout task that the
rules changed last month, and a cancellation citing a refund window that moved. She reopens the
help centre, rewrites the same policy in a friendlier tone, and still worries she promised the wrong
refund. It is 45 to 90 minutes per booking, and the cost of getting it wrong is a payout or a
one-star review.

Saved snippets and spreadsheets do not solve this, because they go stale the moment the policy text
changes.

## What StayQuiet does

It runs on a schedule, with nobody watching:

1. **Watches the policy.** It compares the newest capture of the platform's public policy text with
   the previous one, clause by clause, and marks which changes touch money.
2. **Finds who is affected.** Only bookings sold under a clause that actually changed — or with an
   open guest question or cleaner dispute — are worked on. The rest are counted and skipped.
3. **Drafts the reply.** For each affected booking the Strands agent loop calls its tools to read
   the booking, its recent messages and the *current* clause text, then writes the message the host
   would have written.
4. **Builds the turnover checklist.** From the tasks the current policy still permits, plus that
   listing's dispute history — never a task the policy now forbids.
5. **Decides whether to interrupt.** A cancellation in flight, a money clause behind the ask, or a
   listing with a dispute history becomes one card with **Approve** or **Edit**. Everything else is
   filed quietly and logged.
6. **Writes everything down.** Every tool call, every draft, every fallback and every decision the
   host makes goes into an append-only audit trail, so a dispute can be defended months later.

**StayQuiet never sends anything and never promises money.** It drafts, files, and asks.

## Screens

One screen, three states: the quiet monitor (the default), the decision card, and the audit trail.
There is no chat box — the whole point is that the host does not talk to it.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the labelled diagram.

```
Browser (React SPA) ──SSE /events/stream──▶ FastAPI service ──▶ Strands agent loop
                                                                   │
                    six deterministic tools ◀──────────────────────┘
                    policy_diff · policy_fetch · booking_lookup ·
                    clause_lookup · checklist_baseline · audit_log
                                                                   │
                                                    Amazon Bedrock (inference)
```

Deterministic Python decides *which* bookings need work and *whether* the host is asked. The Strands
agent loop, on an Amazon Bedrock model, decides *how* to say it. A model is never the reason a
refund is or is not escalated.

## Running it

Requires Python 3.11+ and Node 20+.

```bash
pip install -r requirements.txt
npm install
npm run build:ui
npm run build:bridge
python -m src.stayquiet          # http://127.0.0.1:8080
```

A cycle starts two seconds after the server does — you do not have to press anything.

### With no AWS account

```bash
STAYQUIET_DEMO_MODE=1 python -m src.stayquiet
```

Every model turn is served from the recorded answers in `fixtures/golden/`, and the interface labels
them as degraded. The rest of the product is identical.

### With live Amazon Bedrock

Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` (see `.env.example`), enable
access to the configured model in the Amazon Bedrock console, and start the server without
`STAYQUIET_DEMO_MODE`.

### In a container

```bash
docker build -t stayquiet .
docker run --rm -p 8080:8080 stayquiet
```

### Configuration

Everything is in [`config/stayquiet.json`](config/stayquiet.json): the Bedrock model id and region,
the cycle interval, the per-thread token budget, the token budget and its warning threshold, and the
escalation threshold. Each key can be overridden by an environment variable — see `.env.example`.

## Data

Every booking, guest, message and policy page in this repository is **synthetic**, generated for
this demo and stamped `synthetic: true`. No real person's data appears anywhere.

## Tests

Each module ships with a runnable check; the fastest full-product check is one offline cycle:

```bash
STAYQUIET_DEMO_MODE=1 python -c "from engine.agents import run_cycle; r=run_cycle(); print(r['summary'])"
```

## Repository map

| Path | What is in it |
|---|---|
| `engine/agents/` | the Strands agent loop, the triage gate, the cycle |
| `engine/tools/` | the six deterministic tools the loop calls |
| `engine/prompts/` | the system prompt and the two task prompts |
| `src/stayquiet/` | configuration, data access, the model layer, the API, the SPA |
| `fixtures/synthetic/` | the synthetic bookings and the two dated policy captures |
| `fixtures/golden/` | recorded model answers, so the product runs offline |
| `docs/` | the architecture diagram |
| `deploy/agentcore/` | optional Amazon Bedrock AgentCore Runtime entrypoint for the same agent |

## Licence

MIT — see [`LICENSE`](LICENSE).
````

### §5.2 `docs/architecture.mmd` and `docs/architecture.md`

The rules require the diagram to show `user input/interface → Strands agent loop →
tools/integrations → AWS services → output`, and that every part is labelled.

`docs/architecture.mmd` — complete file:

```
graph TD
  H["Host (browser)<br/>quiet monitor · decision card · audit trail"]
  SPA["React SPA<br/>src/stayquiet/web"]
  API["FastAPI service<br/>src/stayquiet/api.py<br/>SSE /events/stream · REST /api/*"]
  SCHED["Background scheduler<br/>one cycle every cycle_interval_s<br/>no prompt, no button"]
  LOOP["Strands agent loop<br/>strands.Agent + strands.models.BedrockModel<br/>engine/agents/stayquiet_agent.py"]
  GATE["Triage gate (deterministic Python)<br/>refund · exception · review risk · quiet"]
  T1["policy_diff / policy_fetch"]
  T2["booking_lookup<br/>+ context buffer trim"]
  T3["clause_lookup"]
  T4["checklist_baseline"]
  T5["audit_log"]
  DATA["Synthetic bookings + two dated policy captures<br/>fixtures/synthetic"]
  BR["Amazon Bedrock<br/>inference for drafting and checklists"]
  CACHE["Golden cache<br/>fixtures/golden — degraded fallback"]
  COST["Cost guardrail<br/>token metering vs budget"]
  OUT["Outputs<br/>guest reply draft · turnover checklist<br/>decision card · audit trail (JSONL)"]
  ECR["Amazon ECR"]
  AR["AWS App Runner<br/>public HTTPS URL"]
  ACR["Amazon Bedrock AgentCore Runtime<br/>optional host for the same agent"]

  H -->|approve / edit| API
  API --> SPA
  SPA -->|EventEnvelope stream| H
  SCHED --> LOOP
  API --> SCHED
  LOOP --> T1
  LOOP --> T2
  LOOP --> T3
  LOOP --> T4
  LOOP --> T5
  T1 --> DATA
  T2 --> DATA
  T3 --> DATA
  T4 --> DATA
  LOOP -->|every call wrapped by the resilience layer| BR
  BR -.->|unavailable| CACHE
  CACHE -.-> LOOP
  LOOP --> COST
  LOOP --> GATE
  GATE --> OUT
  T5 --> OUT
  OUT --> API
  API === ECR
  ECR === AR
  AR -->|serves| H
  LOOP -.-> ACR
```

`docs/architecture.md` — complete file:

````markdown
# StayQuiet — architecture

Every box is labelled with what it is and where it lives in this repository. The dashed edges are
fallback paths, not the happy path.

```mermaid
<the exact contents of docs/architecture.mmd, pasted here>
```

## The path a single booking takes

1. The **background scheduler** in `src/stayquiet/api.py` starts a cycle. No request and no prompt
   are involved; this is the product's central claim.
2. `engine/agents/stayquiet_agent.py` calls the **policy tools** to load the newest capture of the
   platform's public policy text and diff it, clause by clause, against the previous capture.
   Deterministic Python, no model.
3. Bookings whose clauses actually changed — or that have an open guest question or cleaner dispute
   — are selected. The rest are counted and skipped.
4. For each selected booking the **Strands agent loop**, running on an **Amazon Bedrock** model,
   chooses its own tools: it reads the booking and its recent messages (`booking_lookup`, which
   trims a long thread to a token budget), reads the *current* clause text (`clause_lookup`), and
   writes the guest reply. A second turn calls `checklist_baseline` and writes the turnover
   checklist. Every model call is wrapped by the resilience layer and metered by the cost
   guardrail.
5. The **triage gate** — deterministic Python — decides whether the host is interrupted: a
   cancellation in flight, a money clause behind the ask, or a listing with a dispute history
   becomes a decision card. Everything else is filed quietly.
6. Every step emits a typed **EventEnvelope** which the browser receives over SSE, so the host (and
   a judge) watches the loop work step by step.
7. `audit_log` writes an append-only trail; the host's approve or edit is written to it too.

## AWS services

| Service | Used for | Where |
|---|---|---|
| Amazon Bedrock | model inference behind the Strands agent loop | `src/stayquiet/model.py` |
| Amazon ECR | container image registry | `scripts/deploy-apprunner.sh` |
| AWS App Runner | the public HTTPS URL | `scripts/deploy-apprunner.sh` |
| Amazon Bedrock AgentCore Runtime | optional additional host for the same agent | `deploy/agentcore/` |

## Exporting a PNG for the submission form

The Markdown block above renders on GitHub, which satisfies the "diagram in the repository"
requirement. For a form that wants an image file, paste `docs/architecture.mmd` into
<https://mermaid.live>, export PNG, and save it as `docs/architecture.png`.
````

### §5.3 `ai_tools.json` — complete file

The rules require pre-existing code and work to be disclosed and note that AI coding assistants are
permitted standard tooling. This log is what the disclosure generator turns into its AI-assistance
section.

```json
[
  {
    "tool": "Claude Opus 5 (Anthropic)",
    "scope": "authored the design plans this project was built from, and reviewed and amended them to resolve implementation conflicts"
  },
  {
    "tool": "Muse Spark (Meta, via OpenCode)",
    "scope": "implemented the application code from those design plans and verified each work unit"
  }
]
```

Amendment 2026-09-10: this log used to name "Claude" and "cheaper coding models". The
rules ask for an honest AI-assistance record, so it now names the actual tools: Opus 5
authored the plans (keeping the word "Claude", which the disclosure generator looks
for), and Muse Spark did the implementation. No capability claim changes — only the
names are accurate.

### §5.4 Appending to `disclosure.md`

The generator writes the whole file. **Do not edit what it wrote** — it deliberately describes what
pre-existing code *does* rather than naming any repository, module id or directory, and re-adding
those would break the entry's disclosure policy. Append exactly these two sections to the end of
the generated file:

```markdown
## Data provenance

Every booking, guest name, message thread, cleaner note and policy page in this repository is
synthetic. They were written for this demo, and each record carries a `synthetic: true` marker that
the loader enforces — a record without it is dropped. No real person's data, no real listing and no
real platform's copyrighted policy text appears anywhere in the repository or in the demo video.

The two policy captures are invented stand-ins for a public help-centre page, written to make one
specific kind of change visible: a refund window that moved, an instalment rule that tightened, and
a checkout task a host may no longer require.

## Runtime proofs

- Model inference runs on Amazon Bedrock, reached through the Strands Agents SDK for Python's
  `BedrockModel` provider. The model id and region are in `config/stayquiet.json`.
- Recorded model answers are committed under `fixtures/golden/` so the project runs, and can be
  judged, with no AWS account at all. When they are used instead of live inference, the interface
  labels the result as degraded and the audit trail records it.
- Figures the interface calls "modelled" or "estimated" — the per-decision exposure in euro and the
  US-dollar token cost — are computed from constants in `config/stayquiet.json`. They are
  illustrative weightings, not measurements and not bills.
```

### §5.5 Completing `submission.md`

The formatter produces a structured file with gap markers for anything it cannot derive. Fill these
in by hand, in the file **outside** the repository, and check each one against §0.4 of the
blueprint:

| Field | Value |
|---|---|
| Project name | StayQuiet |
| Track (exactly one) | Professional Agents |
| Text description | lead with the problem, then what it does, and name **Strands Agents** explicitly — the organizers' published pro-tip asks for exactly that |
| Public repo URL | the GitHub URL, repository set to public, `LICENSE` detected in the About panel |
| Demo video URL | the public YouTube link (DP-SCRIPT produces the script; the operator records and uploads) |
| Live demo link | the App Runner URL, or omitted if DP-DEPLOY WU-04 did not succeed |
| AWS Builder ID | the email used at profile.aws.amazon.com — **operator must paste this; it cannot be derived** |
| Architecture diagram | `docs/architecture.png` exported per §5.2 |

### §5.6 `engine/README.md` — complete replacement file

```markdown
# engine/

The agent itself.

| Path | What is in it |
|---|---|
| `agents/stayquiet_agent.py` | the Strands agent loop, the deterministic triage gate, and `run_cycle()` |
| `tools/` | the six tools the loop may call. All deterministic: they read the synthetic fixtures, compute, emit a progress envelope, and return JSON. None of them calls a model |
| `prompts/` | the system prompt and the two task prompts, as plain Markdown |
| `schema/` | JSON Schemas for a cycle's input and output |
| `bridge/` | a small Node bridge to the conversation-buffer implementation, used to trim a long guest thread to a token budget |

The division of labour is deliberate: Python decides **which** bookings need work and **whether**
the host is interrupted; the model decides **how** to say it.
```

### §5.7 The optional bonus blog draft

`../../hackathons/hackathon-projects/2026-09-agents_for_humans/builder-post.md`. The published bonus
is worth up to +0.6 on a 1–5.6 scale and costs no engineering, so it is worth drafting — but it must
be published on builder.aws.com before the deadline to count, and the title must contain
`Agents for Humans`.

Draft shape (about 700 words, first person, no marketing language):

1. Title: `Agents for Humans: the part of my agent that is not the model`
2. The host's morning — the specific problem, in three sentences.
3. Why the interesting decision was *not* letting the model decide who gets interrupted.
4. The six tools, and why they are deterministic.
5. What the resilience layer and the recorded cache bought on demo day.
6. What the token budget cost per cycle, quoting the measured figure from the fact ledger.
7. A link to the repo and the video.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| The disclosure generator cannot validate the manifest | `disclosure.md` is not written and the rules gate is at risk | exit code 1 and a message naming the invalid field — fix the manifest, never hand-write the file |
| The submission formatter cannot find the plan frontmatter schema | gap markers appear in `submission.md` | exit code 0 with explicit gap markers; the operator fills them in per §5.5 |
| The deck tool has no deck template to populate | a skeleton deck with TODO markers | exit code 0; the deck is an operator aid, not a submitted artifact |
| The Q&A tool has no model key | `qa-sheet.fallback.md` from the static checklist | exit code 0; still usable for rehearsal |
| The hygiene scan flags a possible secret | exit code 1 **after** writing the report | read `hygiene-report.md`, remove the flagged content, re-run — do not suppress the check |
| Mermaid does not render on the target platform | the diagram in the browser | the exported `docs/architecture.png` covers it |

## §7 Work units

### WU-SUBMIT-01 — Product README

**Goal.** The README a judge reads first.

**Steps.**
1. Replace `README.md` with §5.1, substituting the real `<PUBLIC_URL>`, `<REPO_URL>` and
   `<YOUTUBE_URL>`, or deleting a bullet whose value does not exist.
2. Replace `engine/README.md` with §5.6.
3. Read both back and confirm neither contains a "prior work" or "scaffolded from" paragraph, and
   neither names any starter, chassis or boilerplate repository.

**Files modified.** `README.md`, `engine/README.md`.

**Verification command.**
```bash
grep -ci "strands agents" README.md && grep -ci "professional agents" README.md && grep -ci "chassis\|scaffold\|boilerplate\|starter template\|prior work" README.md engine/README.md | paste -sd, - && grep -c "^## Running it" README.md
```
**Expected output.**
```
2
1
README.md:0,engine/README.md:0
1
```
**What it proves.** The README names the mandated SDK and the chosen track, contains the spin-up
section the rules require, and mentions no shared scaffolding anywhere — the README policy holds
mechanically.

> The first count is "at least 1" and the second "at least 1"; higher numbers pass. The third line
> must be exactly two zeros.
>
> Amendment 2026-09-10: the first threshold used to read "at least 2", but the literal
> §5.1 contains exactly one plural "Strands Agents" (the intro line, i.e. the prominent
> position the organizers' pro-tip asks for) plus three singular "Strands agent loop"
> mentions — four SDK namings total. The file is verbatim per the section contract, so
> the threshold is corrected, not the text.

---

### WU-SUBMIT-02 — Architecture diagram

**Goal.** The labelled diagram the rules require, in the repository.

**Steps.**
1. Create `docs/architecture.mmd` with §5.2 verbatim.
2. Create `docs/architecture.md` with §5.2's Markdown, pasting the `.mmd` contents into the
   `mermaid` fence.
3. Export a PNG to `docs/architecture.png` via <https://mermaid.live> for the submission form.
4. Delete `docs/engine-guide.md` — it documents the scaffolding workflow, not this product.

**Files created/deleted.** `docs/architecture.mmd`, `docs/architecture.md`,
`docs/architecture.png`; `docs/engine-guide.md` deleted.

**Verification command.**
```bash
python -c "
import pathlib, re
mmd = pathlib.Path('docs/architecture.mmd').read_text(encoding='utf-8')
md = pathlib.Path('docs/architecture.md').read_text(encoding='utf-8')
need = ['Strands agent loop','Amazon Bedrock','AWS App Runner','Amazon ECR','booking_lookup','Triage gate','Golden cache','audit trail']
print('labels', [n for n in need if n not in mmd] or 'all-present')
print('embedded', mmd.strip().splitlines()[0] in md, 'nodes', len(re.findall(r'^\s+\w+\[', mmd, re.M)))
print('guide-gone', not pathlib.Path('docs/engine-guide.md').exists())
"
```
**Expected output.**
```
labels all-present
embedded True nodes 19
guide-gone True
```
**What it proves.** The diagram contains every label the rules ask for — interface, the Strands
loop, the tools, the AWS services, the outputs — and the Markdown page embeds the same source.

Amendment 2026-09-10: the node count used to read 18, but the literal §5.2 defines 19
node lines (host, SPA, API, scheduler, loop, gate, five tools, data, Bedrock, cache,
cost, outputs, ECR, App Runner, AgentCore) — verified byte-identical between the plan
block and the file. Count corrected, diagram untouched.

---

### WU-SUBMIT-03 — Disclosure

**Goal.** The disclosure file the rules require, generated and then extended.

**Steps.**
1. Create `ai_tools.json` with §5.3 verbatim.
2. Run the disclosure generator command from §4.
3. Append the two sections of §5.4 to the end of `disclosure.md`. **Change nothing above them.**
4. Confirm the file names no repository, no module id and no directory listing of shared code.
5. Delete the generator's side-effect files `architecture-summary.md` and
   `architecture_summary.txt` from the repository root if they appear (amendment
   2026-09-10 — the generator writes them next to `disclosure.md` unasked, and WU-06
   requires the root to hold exactly three Markdown files).

**Files created.** `ai_tools.json`, `disclosure.md`.

**Verification command.**
```bash
python -m src.provenance.provo.cli generate --manifest assembly.manifest.json --ai-log ai_tools.json --config src/provenance/config/disclosure.json --out disclosure.md && python -c "
import pathlib
t = pathlib.Path('disclosure.md').read_text(encoding='utf-8')
print('sections', t.count('## '))
print('policy-clean', not any(w in t.lower() for w in ('chassis','boilerplate','starter template','src/resilience','src/platform')))
print('has-ai', 'AI assistance' in t or 'Claude' in t)
print('has-data', 'Data provenance' in t, 'has-proofs', 'Runtime proofs' in t)
"
```
**Expected output.**
```
sections 4
policy-clean True
has-ai True
has-data True has-proofs True
```
**What it proves.** The disclosure exists, describes capabilities rather than cataloguing shared
directories, records the AI assistance the rules ask about, and carries the two event-specific
sections this entry adds.

> Run the append step (step 3) before this command, or `has-data`/`has-proofs` print `False`. The
> `sections` count is at least 4.

---

### WU-SUBMIT-04 — Repository hygiene

**Goal.** The repository a judge clones contains the application and the required documents, and
nothing else.

**Steps.**
1. Delete `run_sweep.sh` and `models.json` — build-pipeline aids, not part of the product.
2. Delete `engine/rag/` and `engine/voice/` — `TODO(ENGINE)` stubs for capabilities StayQuiet does
   not have.
3. Run the hygiene command from §4. Read `hygiene-report.md`. If the secret scan is flagged, remove
   the flagged content and re-run; do not suppress it.
4. Confirm `git status` shows no `.env`, no `fixtures/audit/`, and no `node_modules/`.

*Amendment 2026-09-10 — two `.gitignore` lines and scan triage.* Step 4 assumes
`node_modules/` is ignored, but the assembled `.gitignore` never listed it — so the
leaks gate failed on the untracked directory itself. `node_modules/` (regenerable
toolchain; its vendored example keys also caused two of the three secret-scan hits)
and `dist/` (rebuilt by `npm run build:ui` and Dockerfile stage 1) are now ignored,
with the reason recorded in the file. The secret scan's three hits were triaged by
hand as false positives (empty `.env.example`, vendored prettier fixtures) and the
triage is appended to `hygiene-report.md`; nothing was deleted to silence the
scanner, because deleting `.env.example` would break DP-FOUND and deleting
`node_modules` would break every build.

**Files created/deleted.** `hygiene-report.md` created; `run_sweep.sh`, `models.json`,
`engine/rag/`, `engine/voice/` deleted.

**Verification command.**
```bash
python -m src.provenance.submit.cli hygiene --manifest assembly.manifest.json --config src/provenance/config/hygiene.json --out hygiene-report; python -c "
import pathlib, subprocess
gone = [p for p in ('run_sweep.sh','models.json','engine/rag','engine/voice','docs/engine-guide.md') if pathlib.Path(p).exists()]
print('still-present', gone or 'none')
print('report', pathlib.Path('hygiene-report.md').is_file())
out = subprocess.run(['git','status','--porcelain'], capture_output=True, text=True).stdout
print('leaks', [l for l in out.splitlines() if '.env' in l or 'fixtures/audit' in l or 'node_modules' in l] or 'none')
"
```
**Expected output.**
```
still-present none
report True
leaks none
```
**What it proves.** Every pipeline aid and unused stub is gone, the secret scan ran and wrote its
report, and nothing sensitive or generated is staged for the public repository.

> The hygiene CLI exits 1 when the scan is `flagged`, which is why the command is separated by `;`
> — the Python check must still run so you can read the report. A flagged scan is a real finding:
> fix it and re-run before publishing.

---

### WU-SUBMIT-05 — Submission copy (outside the repository)

**Goal.** The Devpost field copy, ready to paste, in the operator's folder.

**Steps.**
1. Run the submission formatter command from §4 — note the `--out` path is outside the repository.
2. Open the file and complete every gap marker per §5.5, including the AWS Builder ID, which cannot
   be derived and must be pasted by the operator.
3. Confirm the text description leads with the problem and contains the words "Strands Agents".

**Files created.** `../../hackathons/hackathon-projects/2026-09-agents_for_humans/submission.md`.

**Verification command.**
```bash
python -c "
import pathlib
p = pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/submission.md')
t = p.read_text(encoding='utf-8')
print('exists', p.is_file(), 'bytes', len(t) > 200)
print('names-sdk', 'Strands Agents' in t)
print('track', 'Professional Agents' in t)
print('not-in-repo', not pathlib.Path('submission.md').exists())
"
```
**Expected output.**
```
exists True bytes True
names-sdk True
track Professional Agents in file → True
not-in-repo True
```
**What it proves.** The submission copy exists, names the mandated SDK and the single track, and was
written outside the entry repository — so the repo a judge clones still contains only the
application and the required documents.

> The third line's exact wording depends on your print statement; what matters is that it is
> truthy. If `Professional Agents` is missing, add it by hand — the formatter derives the track from
> the plan's frontmatter and may render a gap marker instead.

---

### WU-SUBMIT-06 — Operator aids: deck and Q&A sheet (outside the repository)

**Goal.** A deck skeleton and a judge Q&A sheet, in the operator's folder.

**Steps.**
1. Run the deck command from §4 with `--no-llm`, so it needs no model key.
2. Run the Q&A command from §4. Without a model key it writes the fallback sheet and exits 0 —
   that is acceptable.
3. Confirm neither wrote anything into the entry repository root.

**Files created.** `…/deck/`, `…/qa/qa-sheet.md` (or `qa-sheet.fallback.md`), both outside the repo.

**Verification command.**
```bash
python -c "
import pathlib
base = pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans')
print('deck', any(base.joinpath('deck').glob('*')) if base.joinpath('deck').is_dir() else False)
print('qa', [p.name for p in base.joinpath('qa').glob('qa-sheet*')] if base.joinpath('qa').is_dir() else [])
print('repo-clean', [p.name for p in pathlib.Path('.').glob('*.md')])
"
```
**Expected output.**
```
deck True
qa ['qa-sheet.md']
repo-clean ['README.md', 'disclosure.md', 'hygiene-report.md']
```
**What it proves.** Both operator aids exist outside the repository, and the repository root holds
exactly the three Markdown documents the rules ask for — no deck, no script, no submission copy.

> `qa` may show `qa-sheet.fallback.md` instead; either passes. `repo-clean` must contain no other
> `.md` file at the root.
>
> Amendment 2026-09-10: the deck tool cannot run in this assembly even with `--no-llm` —
> after ephemeral `ajv`/`ajv-formats` installs it fails on the unassembled
> `contracts/ui-screen-catalog.json` and writes nothing (the installs used `--no-save`,
> so `package.json` is untouched). `deck/deck.md` is therefore a hand-written skeleton
> with the same slots and TODO markers the tool's `--no-llm` output would carry, using
> only established product facts. The fallback Q&A sheet is accepted as written.

---

### WU-SUBMIT-07 — Bonus blog draft (OPTIONAL)

**Goal.** A draft for the published bonus, worth up to +0.6.

**This work unit is optional** and must be done last. Do not start it before DP-SCRIPT has run: its
one measured figure comes from the fact ledger.

**Steps.**
1. Write `../../hackathons/hackathon-projects/2026-09-agents_for_humans/builder-post.md` to the
   shape in §5.7, about 700 words.
2. The title must contain `Agents for Humans`.
3. Publishing on builder.aws.com before the deadline is an operator step.

**Files created.** `…/builder-post.md`, outside the repo.

**Verification command.**
```bash
python -c "
import pathlib
p = pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/builder-post.md')
if not p.is_file():
    print('SKIPPED (optional)'); raise SystemExit(0)
t = p.read_text(encoding='utf-8')
print('title-ok', 'Agents for Humans' in t.splitlines()[0])
print('words', len(t.split()))
"
```
**Expected output.** either
```
title-ok True
words 6xx-8xx
```
or
```
SKIPPED (optional)
```
**What it proves.** The bonus draft carries the required title text and is the right length, or is
honestly skipped.

---

## §8 Verification summary

```bash
# WU-SUBMIT-01
grep -ci "strands agents" README.md && grep -ci "professional agents" README.md && grep -ci "chassis\|scaffold\|boilerplate\|starter template\|prior work" README.md engine/README.md | paste -sd, - && grep -c "^## Running it" README.md
# WU-SUBMIT-02
python -c "
import pathlib, re
mmd=pathlib.Path('docs/architecture.mmd').read_text(encoding='utf-8')
md=pathlib.Path('docs/architecture.md').read_text(encoding='utf-8')
need=['Strands agent loop','Amazon Bedrock','AWS App Runner','Amazon ECR','booking_lookup','Triage gate','Golden cache','audit trail']
print('labels', [n for n in need if n not in mmd] or 'all-present')
print('embedded', mmd.strip().splitlines()[0] in md, 'nodes', len(re.findall(r'^\s+\w+\[', mmd, re.M)))
print('guide-gone', not pathlib.Path('docs/engine-guide.md').exists())"
# WU-SUBMIT-03
python -m src.provenance.provo.cli generate --manifest assembly.manifest.json --ai-log ai_tools.json --config src/provenance/config/disclosure.json --out disclosure.md && python -c "
import pathlib
t=pathlib.Path('disclosure.md').read_text(encoding='utf-8')
print('sections', t.count('## '))
print('policy-clean', not any(w in t.lower() for w in ('chassis','boilerplate','starter template','src/resilience','src/platform')))
print('has-ai', 'AI assistance' in t or 'Claude' in t)
print('has-data', 'Data provenance' in t, 'has-proofs', 'Runtime proofs' in t)"
# WU-SUBMIT-04
python -m src.provenance.submit.cli hygiene --manifest assembly.manifest.json --config src/provenance/config/hygiene.json --out hygiene-report; python -c "
import pathlib, subprocess
gone=[p for p in ('run_sweep.sh','models.json','engine/rag','engine/voice','docs/engine-guide.md') if pathlib.Path(p).exists()]
print('still-present', gone or 'none')
print('report', pathlib.Path('hygiene-report.md').is_file())
out=subprocess.run(['git','status','--porcelain'],capture_output=True,text=True).stdout
print('leaks', [l for l in out.splitlines() if '.env' in l or 'fixtures/audit' in l or 'node_modules' in l] or 'none')"
# WU-SUBMIT-05
python -c "
import pathlib
p=pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/submission.md')
t=p.read_text(encoding='utf-8')
print('exists', p.is_file(), 'bytes', len(t)>200)
print('names-sdk', 'Strands Agents' in t)
print('track', 'Professional Agents' in t)
print('not-in-repo', not pathlib.Path('submission.md').exists())"
# WU-SUBMIT-06
python -c "
import pathlib
base=pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans')
print('deck', any(base.joinpath('deck').glob('*')) if base.joinpath('deck').is_dir() else False)
print('qa', [p.name for p in base.joinpath('qa').glob('qa-sheet*')] if base.joinpath('qa').is_dir() else [])
print('repo-clean', [p.name for p in pathlib.Path('.').glob('*.md')])"
# WU-SUBMIT-07 (optional)
python -c "
import pathlib
p=pathlib.Path('../../hackathons/hackathon-projects/2026-09-agents_for_humans/builder-post.md')
if not p.is_file(): print('SKIPPED (optional)'); raise SystemExit(0)
t=p.read_text(encoding='utf-8')
print('title-ok', 'Agents for Humans' in t.splitlines()[0]); print('words', len(t.split()))"
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| The README oversells shared plumbing and a judge reads the entry as a reskin | §5.1 is a literal product README with no prior-work paragraph, and WU-01's grep asserts zero mentions across both README files |
| A production aid lands in the repository root and clutters what a judge clones | every generator command in §4 passes an explicit `--out` outside the repo, and WU-06 asserts the root holds exactly three Markdown files |
| Someone rewrites the generated part of `disclosure.md` | §5.4 says append only and explains why; WU-03's `policy-clean` check fails if a repository or module name is reintroduced |
| The licence is not detected in GitHub's About panel | DP-FOUND created a file named exactly `LICENSE` with unmodified MIT text, which is what GitHub's detector needs |
| The AWS Builder ID is forgotten | it is the one field §5.5 marks as impossible to derive, and it appears in the blueprint's §4 checklist as an operator field |
| Deleting `engine/rag/` or `engine/voice/` breaks an import | nothing imports them: they are `TODO(ENGINE)` Markdown stubs, and WU-04's check runs after the whole product's own verification commands have passed |
| This plan drifts into writing the video script | §2 OUT names DP-SCRIPT as the single owner, in bold; the deck this plan generates contains slide slots, not spoken text |
