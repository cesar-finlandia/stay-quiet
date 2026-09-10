# Master Blueprint — StayQuiet (2026-09 Agents for Humans, AWS + Devpost)

> **Entry:** StayQuiet — a background agent for independent short-stay hosts.
> **Track (exactly one):** Professional Agents.
> **Mandated technology:** Strands Agents SDK (Python) with Amazon Bedrock models on AWS.
> **Hard deadline:** 2026-09-14 17:00 PDT. Internal freeze: 2026-09-13 EOD EEST.
> **Sources:** `design_documents/winning_project_plan.md` (WHAT), `design_documents/hackathon_brief.md`
> §4 (rules — `event_profile.json` was written with every field
> `"not extracted — confirm manually"`, so the brief is the binding fallback source per
> the prompt's READ FIRST item 6), `design_documents/proposal.json` (module selection).

This document plus §3's plan map is the single binding contract between all eleven design
plans. An implementor never reads this file — they read exactly one `DP-*.md` and the code it
names. This file exists so that the plans cannot contradict each other.

---

## §0 Mandatory-compliance extraction (disqualification-level, verbatim)

Extracted before any design, from `design_documents/hackathon_brief.md` §4 (which transcribes the
Devpost Overview / Rules / Resources / FAQ pages of 2026-09-09) and §2.

### §0.1 MANDATORY TECHNOLOGIES — verbatim

> "**Build a new AI agent with Strands Agents that does real work for real people. Your agent
> should take on something people actually deal with — and handle it end to end, not just chat
> about it. Enter it in one of the three tracks below.**"

> "Sign up for an [AWS Account.](https://signin.aws.amazon.com/signup?request_type=register)"
> "[Install the Strands Agents SDK](https://strandsagents.com/docs/user-guide/quickstart/overview/)"

> "*Deploying with Amazon Bedrock AgentCore is a smart architectural choice and will strengthen
> your Technical Implementation score, but it's not required.*"

Binding reading: the ONLY hard technology mandate is the **Strands Agents SDK** (Python or
TypeScript) plus an **AWS account**. This entry uses **Strands Agents SDK for Python** with
**Amazon Bedrock** models. AgentCore is explicitly optional and is treated as such (§5 ladder).
No other stack is mandated — nothing about Vercel, Gemini, WebMCP or AssemblyAI applies here and
none of those names appear anywhere in this entry.

### §0.2 PRIZE TRACKS — verbatim

> "1. **Everyday Agents** - an agent that takes the busywork out of daily life, home, money,
> health, errands, family. The best ones run quietly in the background and only ping you when
> there's a real decision to make."
> "2. **Professional Agents** - an agent that makes someone dramatically better at the work they
> already do, professionals, makers, creators, small-business owners. Target the repetitive,
> judgment-heavy tasks that eat their day."
> "3. **Good Neighbor Agents** - an agent that helps groups of people, not just one,
> neighborhoods, nonprofits, food banks, schools, libraries, small local orgs."

FAQ: "your Project may only fall into one track". Prizes: Grand Prize $10,000 (all eligible
submissions) + per-track Gold $5,000 / Silver $3,000 / Bronze $2,000. "A Project can win one (1)
Prize."

**Track choice: Professional Agents.** Justification as highest win-probability track for this
idea: the primary user is a solo short-stay host running a micro-business — skilled,
judgment-heavy work (pricing, refunds, dispute defence) buried in repetitive admin (rewriting the
same policy replies, rebuilding the same turnover checklist). That is a verbatim match for
"small-business owners … repetitive, judgment-heavy tasks that eat their day", and it is a
*worse* match for Everyday (not the host's personal life; it is her income) and for Good
Neighbor (one operator, not a group). Single-track entry is mandatory, so there is no hedging
decision to make and no track dilution to trade off.

### §0.3 JUDGING — verbatim axes and method

> "Stage One) The first stage will determine via pass/fail whether the ideas meet a baseline
> level of viability" · "Stage Two) All Submissions that pass Stage One will be evaluated in
> Stage Two based on the following **equally weighted criteria**"

| Axis | Verbatim "what judges look for" |
|---|---|
| Technical Implementation | "How thoroughly/skillfully Strands Agents is used; genuine effort, working non-trivial implementation; live demo and/or AgentCore deployment strengthen this score" |
| Design | "Complete, coherent product experience — not just a technical proof of concept" |
| Potential Impact | "Credible, specific case for solving a real problem for a real audience — and the demo actually addresses it" |
| Creativity & Originality | "Creative, non-obvious use of Strands Agents + genuine understanding of the problem space" |
| Presentation | "Video clearly demonstrates the project end-to-end; pitch communicates problem / who / why; easy to follow" |

Five axes, equal weight. Tie-break: highest score on the first listed criterion, then down the
list. Final scores 1–5.6.

### §0.4 SUBMISSION GATE — verbatim field list

1. Project built with Strands Agents SDK meeting the Project Requirements.
2. Text description — features and functionality (organizer pro-tip: "Name Strands Agents explicitly").
3. "Provide a PUBLIC URL to your code repository (on github, gitlab or bitbucket) … The
   repository must be public and **include MIT/Apache open source license** by including an open
   source license file. This license should be detectable and visible at the top of the
   repository page (in the About section)."
4. README in the repo.
5. Architecture diagram — "user input/interface → Strands agent loop → tools/integrations → AWS
   services → output; beauty optional, labels required".
6. "Include a video (**maximum 5 minutes**) … Demonstration of your working project … Pitch …
   must cover: (1) the problem you're solving (2) who it's for (3) why it matters … Videos must
   be uploaded to YouTube or Vimeo and made public."
7. Track selection (exactly one of the three).
8. AWS Builder ID (email used at profile.aws.amazon.com).
9. Optional but scoring-relevant: live demo link.
10. Optional bonus: builder.aws.com post(s) with "Agents for Humans" in the title, published
    before the deadline — 0.2 each, max +0.6.

Also binding: "must disclose any other pre-existing code or work incorporated into the Project";
"The Entrant must make the Project available **free of charge and without any restriction, for
testing, evaluation and use** … until the Judging Period ends"; all materials in English.

### §0.5 BONUS — explicit decision

**No bonus integration is taken as a build task.** The only published bonus is the
builder.aws.com blog post (max +0.6 on a 1–5.6 scale). It costs zero product engineering — it is
a writing task the operator can do after the internal freeze — so it is not dilution, and
DP-SUBMIT emits a ready-to-post draft as an *optional* work unit. There is no Gemma/Veo/Lyria
equivalent in this brief and no other bonus exists; nothing else is added.

### §0.6 Mandatory-tech → plan → judging-axis trace

| Mandatory item (from §0.1/§0.4) | Where it is satisfied | Judging axis earned |
|---|---|---|
| Strands Agents SDK (Python) — `from strands import Agent, tool` | DP-AGENT (`engine/agents/stayquiet_agent.py`), DP-TOOLS (six `@tool` functions) | Technical Implementation |
| Amazon Bedrock model access via Strands `BedrockModel` | DP-MODEL (`src/stayquiet/model.py`) | Technical Implementation |
| AWS account / AWS services at runtime | DP-MODEL (Bedrock runtime calls), DP-DEPLOY (Amazon ECR + AWS App Runner public URL) | Technical Implementation |
| "handle it end to end, not just chat about it" | DP-AGENT `run_cycle()` — policy diff → affected bookings → drafts → checklists → decision gate → audit | Potential Impact, Creativity & Originality |
| "runs autonomously and only surfaces when there's a real decision" | DP-API background scheduler + DP-AGENT triage gate + DP-UI quiet-monitor default state | Design, Creativity & Originality |
| Public repo + MIT LICENSE visible in About | DP-FOUND (`LICENSE`), DP-SUBMIT (README, repo hygiene) | Technical Implementation |
| README + spin-up guide | DP-SUBMIT (`README.md` one-command run) | Design, Technical Implementation |
| Architecture diagram with labels | DP-SUBMIT (`docs/architecture.md` + `docs/architecture.mmd`) | Technical Implementation, Presentation |
| Demo video ≤5:00, working project + problem/who/why | DP-SCRIPT (script + slides), DP-DEPLOY (recorded fallback capture) | Presentation |
| Live demo link (optional, scoring-relevant) | DP-DEPLOY (App Runner HTTPS URL) | Technical Implementation |
| AgentCore deployment (optional) | DP-DEPLOY WU-DEPLOY-05 (explicitly skippable) | Technical Implementation |
| Disclosure of pre-existing code | DP-SUBMIT (`disclosure.md` via the generator) | Rules pass/fail |
| Free judge testing until judging ends | DP-DEPLOY (no auth, no rate limit, synthetic data only) | Rules pass/fail |

---

## §1 Requirements

Every requirement traces to a `winning_project_plan.md` section and to a judging axis from §0.3.
IDs are used verbatim by the plans (`§1 Purpose & requirement IDs`).

### §1.1 Functional

| ID | Requirement | Plan source | Axis |
|---|---|---|---|
| SQ-F-01 | The system loads a synthetic booking feed and two dated synthetic help-centre policy snapshots from committed fixtures; every record carries `synthetic: true`. | "Architecture": *synthetic booking feed and help-center snapshots enter a Strands agent loop*; "Suggested Module Emphasis": *Synthetic booking and policy snapshots avoid PII in the public repo* | Potential Impact |
| SQ-F-02 | Policy Watcher produces a deterministic clause-level diff between the two most recent snapshots, classifying each change as added / removed / modified and flagging money-related clauses. | "AI Solution": *Policy Watcher … ingest public help-center and booking snapshots, summarize what changed* | Creativity & Originality |
| SQ-F-03 | Only bookings actually touched by a changed clause (or carrying an open guest question / cleaner dispute) are selected for work; unaffected bookings are counted and skipped. | "AI Solution": *flag only bookings affected* | Creativity & Originality |
| SQ-F-04 | Message Drafter produces a guest-ready reply per affected booking, grounded in the *current* clause text plus that booking's facts, via a Strands tool calling a Bedrock model. | "AI Solution": *draft case-specific guest replies grounded in the current policy excerpt and booking facts* | Technical Implementation |
| SQ-F-05 | Turnover Checklist produces a per-stay checklist from booking details and prior dispute notes. | "AI Solution": *build a per-stay checklist from booking details and prior dispute notes* | Design |
| SQ-F-06 | A decision gate escalates to the host ONLY for refund, exception, or review-risk cases; everything else is acted on quietly and logged. No refund or money action is ever taken without human approval. | "AI Solution": *never sending refunds without human approval*; "Executive Pitch": *pings the host only when a refund, exception, or review-risk decision is real* | Design, Creativity & Originality |
| SQ-F-07 | Each escalation is presented as one decision ping with approve / edit, and resolving it writes the outcome to the audit trail. | "AI Solution": *a one-tap approve/edit* | Design |
| SQ-F-08 | Every agent action, tool call, degraded fallback and human decision is appended to an append-only audit trail readable in the UI and on disk. | "AI Solution": *logging every agent action to an audit trail for dispute defense* | Creativity & Originality |
| SQ-F-09 | The agent runs on a background schedule with no human prompt, and the default UI state is a quiet monitor — not a chat box. | "Executive Pitch": *runs quietly in the background*; brief: *"instead of another app people open and manage"* | Design, Creativity & Originality |
| SQ-F-10 | Every step of a cycle streams to the browser as a typed `EventEnvelope`, so a viewer watches the Strands loop act step by step. | "Suggested Module Emphasis": *typed streaming bus*; "Sponsored Track Strategy": *shows the Strands agent loop invoking policy-fetch/diff and Bedrock-grounded drafting step-by-step in the UI stream* | Presentation, Technical Implementation |
| SQ-F-11 | Long multi-thread guest histories are fitted to a token budget by the context buffer before they reach the model. | "Suggested Module Emphasis": *Context buffer … so long background runs never hit a context wall mid-demo* | Technical Implementation |
| SQ-F-12 | Token and request usage of every Bedrock call is metered and checked against a configured budget, with a warning before the cap. | "Suggested Module Emphasis": *Cost metering guards Bedrock usage under the $50 credit limit* | Technical Implementation |
| SQ-F-13 | The product is reachable at a public HTTPS URL, requires no login, and needs no operator present to be tested. | Brief §0.4 item 9 + "free of charge and without any restriction, for testing" | Technical Implementation |
| SQ-F-14 | The repository ships `README.md`, `LICENSE` (MIT), `disclosure.md`, a labelled architecture diagram, and a one-command spin-up. | Brief §0.4 items 3–5 | Design, Technical Implementation |

### §1.2 Non-functional

| ID | Requirement | Plan source | Axis |
|---|---|---|---|
| SQ-N-01 | Every outbound Bedrock/Strands call is wrapped by `with_resilience`; a provider failure yields a `DegradedResult` served from the golden cache, never an exception and never a blank screen. | "Suggested Module Emphasis": *Resilience wrapper applies to every Strands/AWS outbound call with golden cache as degraded-live fallback* | Technical Implementation |
| SQ-N-02 | A full cycle over the shipped fixtures completes in ≤ 90 s wall clock with live Bedrock, and in ≤ 5 s fully offline from the golden cache. | "Architecture": video plan requires a watchable live run | Presentation |
| SQ-N-03 | Zero real personal data anywhere in the repository; all names, listings, messages and figures are synthetic and marked as such in the UI. | "Suggested Module Emphasis": *avoid PII in the public repo* | Rules pass/fail |
| SQ-N-04 | Deterministic code is preferred to extra LLM calls: exactly two model-backed steps exist per affected booking (draft, checklist). Diffing, matching and triage are pure Python. | Prompt CONSTRAINTS ("Budget honesty") | Technical Implementation |
| SQ-N-05 | Every degraded state is visible, labelled, and non-blocking: the UI shows a degraded badge and the run still completes. | "Suggested Module Emphasis": golden cache as degraded-live fallback | Design |
| SQ-N-06 | No secret, key or account id is committed; the app starts with zero secrets and runs in offline demo mode by default. | Rules (repo is public) | Rules pass/fail |
| SQ-N-07 | The entry repository contains the application and only the documents the rules require; every production aid is written outside it, to `../../hackathons/hackathon-projects/2026-09-agents_for_humans/`. | Prompt "ENTRY REPOSITORY CONTENTS" policy | Design |
| SQ-N-08 | Python 3.11+, Node 20+; one `pip install -r requirements.txt` and one `npm install` are the only setup steps. | Brief: "setup instructions" | Design |

### §1.3 Explicit non-goals

Real Airbnb/Booking.com API integration; sending any message to any real guest; real payments or
refunds; multi-tenant auth; a database server; PDF or voice handling (the `media` module is
excluded by `design_documents/proposal.json`); local eval harness (`dev-tooling` excluded);
re-running problem grounding or event-profile extraction (`pgm`, `profile` excluded);
`assembly-advisory` CLI (excluded).

---

## §2 Architecture

### §2.1 Component and data flow

```
                        ┌────────────────────────── browser (SPA) ──────────────────────────┐
                        │  src/stayquiet/web/*.tsx                                          │
                        │  subscribeEnvelopes() ─► StepStatusIndicator / StreamingTextRenderer│
                        │  QuietMonitor · DecisionPing(approve|edit) · AuditTrail            │
                        └───────▲──────────────────────────────┬────────────────────────────┘
                    SSE GET /events/stream          POST /api/runs · POST /api/decisions/{id}
                                │                              │
        ┌───────────────────────┴──────────────────────────────▼───────────────────────────┐
        │ src/stayquiet/api.py  (FastAPI; also serves the built SPA + GET /events fallback) │
        │   background scheduler → run_cycle() every cycle_interval_s                       │
        └───────────────────────────────────┬──────────────────────────────────────────────┘
                                            │
        ┌───────────────────────────────────▼──────────────────────────────────────────────┐
        │ engine/agents/stayquiet_agent.py — run_cycle()   ◄── the Strands agent loop        │
        │   Agent(model=BedrockModel(...), tools=ALL_TOOLS, system_prompt=…)                │
        └───┬───────────────┬───────────────┬───────────────┬───────────────┬──────────────┘
            │               │               │               │               │
   policy_fetch     policy_diff    booking_lookup   clause_lookup  checklist_baseline  audit_log
            │               │               │               │               │               │
            └──── engine/tools/*.py  (six @tool functions — DP-TOOLS) ──────┴───────────────┘
                        │                             │                        │
        ┌───────────────▼────────────┐   ┌────────────▼─────────────┐  ┌───────▼───────────┐
        │ src/stayquiet/seed.py      │   │ src/stayquiet/model.py    │  │ src/stayquiet/    │
        │ fixtures/synthetic/*.json  │   │ build_agent(), run_agent()│  │ audit.py (JSONL)  │
        │ deterministic diff + match │   │ resilience ▸ cost ▸ Bedrock│  └───────────────────┘
        └────────────────────────────┘   │ context_bridge → CTX (TS)  │
                                          └───────────────────────────┘
                                            │            │           │
                                  src.resilience   src.cost   src/context (Node bridge)
```

Every step of `run_cycle()` calls `src/stayquiet/publish.py:emit()`, which validates and fans an
`EventEnvelope` out to the SSE hub and into an in-memory ring the `GET /events` fallback serves.

### §2.2 The mandated stack, named exactly

* **Agent framework:** Strands Agents SDK for Python — `pip install strands-agents==1.*`;
  `from strands import Agent, tool`; `from strands.models import BedrockModel`.
* **Model + call method:** Amazon Bedrock, model id from `config/stayquiet.json`
  (`"model_id": "global.anthropic.claude-sonnet-4-6"`, region `us-west-2`), reached through
  Strands' `BedrockModel` provider — never through a raw `bedrock-runtime` `invoke_model` call, so
  the Strands loop owns tool selection.
* **AWS services used at runtime:** Amazon Bedrock (inference). **At deploy time:** Amazon ECR
  (image) + AWS App Runner (public HTTPS URL, `scripts/deploy-apprunner.sh`). **Optional:**
  Amazon Bedrock AgentCore Runtime entrypoint (`deploy/agentcore/main.py`, DP-DEPLOY WU-05).
* **Deploy command:** `bash scripts/deploy-apprunner.sh` → prints the App Runner URL; verified by
  `bash scripts/smoke.sh "$PUBLIC_URL"`.
* **Video capture plan:** record the live App Runner URL; if the run is slow, `demodrive`
  captures the same flow offline from the golden cache (`--data-source cache`) as the recorded
  fallback. Both are handled by DP-DEPLOY/DP-SCRIPT, not by improvisation on the day.

### §2.3 EventEnvelope wiring

The envelope shape is defined by `contracts/event-envelope.schema.json` (**v1.1.0** — its v1.0.0
`step_id` pattern accepted kebab-case only and rejected this vocabulary; the pattern was widened to
`^[a-z0-9]+([-_][a-z0-9]+)*$`, a backward-compatible MINOR change justified in the file's own
`$comment`) and mirrored in
`src/platform/transport/event_envelope.py` (Python) and
`src/platform/transport/event-envelope.ts` (TypeScript). **No plan may redefine it.**

```jsonc
{ "step_id": "policy_diff", "status": "started|streaming|done|error",
  "payload": { }, "timestamp": "2026-09-12T10:04:11.117+00:00",
  "sequence": 7, "trace_id": "…uuid4…", "degraded": false }
```

The fixed `step_id` vocabulary — the ONLY values any plan may emit, consume, or label:

| `step_id` | Emitted by | Meaning |
|---|---|---|
| `cycle` | DP-AGENT | wrapper: `started` at cycle open, `done`/`error` at close |
| `policy_fetch` | DP-TOOLS | a policy snapshot was loaded by the agent's tool call |
| `policy_diff` | DP-TOOLS | clause diff computed |
| `booking_scan` | DP-AGENT | affected bookings selected |
| `booking_lookup` | DP-TOOLS | the agent pulled one booking's facts and its context-fitted thread |
| `clause_lookup` | DP-TOOLS | the agent pulled the current text of one clause for grounding |
| `checklist_baseline` | DP-TOOLS | the agent pulled the permitted/forbidden turnover tasks |
| `draft_reply` | DP-AGENT | one guest reply drafted by the Strands loop (`started` → `done`) |
| `turnover_checklist` | DP-AGENT | one checklist finalised by the Strands loop |
| `triage` | DP-AGENT | quiet-vs-escalate decision made |
| `audit_write` | DP-TOOLS | audit entry appended by the agent's tool call |
| `decision_resolved` | DP-API | host approved or edited a ping |

`GET /events/stream` (SSE, `text/event-stream`) is the primary transport; `GET /events` returns a
`FallbackSnapshot` (`{status:"complete", trace_id, events:[…], degraded}`). The frontend subscribes
with its own `subscribeEnvelopes()` (DP-UI §5.4a) rather than the pre-existing `useEventStream`,
which cannot run in a browser — its module graph statically imports `node:fs`, `node:crypto` and
`node:http`, and its per-envelope validation needs `ajv` through `node:module`. The non-streaming
fallback is DP-UI's three-second `/api/state` poll, which carries the same `events` array, so there
is still exactly one error mode and one envelope shape on the frontend.

### §2.4 Inter-module contract table — single owner, N consumers

**This table is binding.** Each row's export is created by exactly one plan. Consumers copy the
import line verbatim from their own §4 and MUST NOT re-declare, re-implement, stub, or
locally re-type any row below. A plan that needs something absent from this table must be
changed, not extended silently.

#### §2.4a Owned by this entry's plans

| # | Export | Owning plan | File (repo-relative) | Signature / shape | Consumers |
|---|---|---|---|---|---|
| 1 | `AppConfig` (TypedDict) | DP-FOUND | `src/stayquiet/config.py` | `{model_id:str, region:str, demo_mode:bool, cycle_interval_s:int, fixtures_dir:str, golden_cache_dir:str, max_bookings:int, thread_token_budget:int, budget_tokens:int, budget_warn_at:float, estimate_usd_per_1k:float, escalate_refund_over_eur:float}` | DP-DATA, DP-MODEL, DP-STREAM, DP-TOOLS, DP-AGENT, DP-API |
| 2 | `load_app_config()` | DP-FOUND | `src/stayquiet/config.py` | `def load_app_config(path: str | None = None) -> AppConfig` — reads `config/stayquiet.json`; missing/corrupt file → hardcoded defaults + one stderr warning; never raises | DP-DATA, DP-MODEL, DP-STREAM, DP-TOOLS, DP-AGENT, DP-API, DP-DEPLOY |
| 3 | `Booking`, `GuestMessage`, `PolicyClause`, `PolicySnapshot`, `ClauseChange`, `BookingImpact` (TypedDicts) | DP-DATA | `src/stayquiet/seed.py` | see DP-DATA §3 for every field | DP-TOOLS, DP-AGENT, DP-API |
| 4 | `load_bookings()` | DP-DATA | `src/stayquiet/seed.py` | `def load_bookings(fixtures_dir: str | None = None) -> list[Booking]` | DP-TOOLS, DP-AGENT |
| 5 | `load_snapshots()` | DP-DATA | `src/stayquiet/seed.py` | `def load_snapshots(fixtures_dir: str | None = None) -> list[PolicySnapshot]` — ascending by `captured_at` | DP-TOOLS |
| 6 | `diff_snapshots()` | DP-DATA | `src/stayquiet/seed.py` | `def diff_snapshots(previous: PolicySnapshot, latest: PolicySnapshot) -> list[ClauseChange]` — pure, deterministic, sorted by `clause_id` | DP-TOOLS |
| 7 | `affected_bookings()` | DP-DATA | `src/stayquiet/seed.py` | `def affected_bookings(bookings: list[Booking], changes: list[ClauseChange]) -> list[BookingImpact]` | DP-AGENT |
| 8 | `find_booking()` | DP-DATA | `src/stayquiet/seed.py` | `def find_booking(booking_id: str, bookings: list[Booking] | None = None) -> Booking | None` | DP-TOOLS |
| 9 | `LlmResult` (TypedDict) | DP-MODEL | `src/stayquiet/model.py` | `{text:str, degraded:bool, reason:str|None, input_tokens:int|None, output_tokens:int|None, source:"live"|"cache"|"none"}` | DP-AGENT |
| 10 | `run_agent()` | DP-MODEL | `src/stayquiet/model.py` | `def run_agent(step_id: str, agent: Any, prompt: str, *, cache_key: str) -> LlmResult` — the ONLY place a Strands agent is invoked: resilience ▸ cost ▸ `agent(prompt)`; never raises | DP-AGENT |
| 11 | `build_agent()` | DP-MODEL | `src/stayquiet/model.py` | `def build_agent(tools: list | None = None, system_prompt: str | None = None) -> Any` — returns a Strands `Agent` on a `BedrockModel` | DP-AGENT, DP-DEPLOY |
| 12 | `result_text()` | DP-MODEL | `src/stayquiet/model.py` | `def result_text(result: Any) -> str` | DP-AGENT, DP-DEPLOY |
| 13 | `usage_extractor()` | DP-MODEL | `src/stayquiet/model.py` | `def usage_extractor(result: Any) -> dict | None` — the `CostMeteringOpts.usage_extractor` hook | internal to DP-MODEL only |
| 14 | `cost_snapshot()` | DP-MODEL | `src/stayquiet/model.py` | `def cost_snapshot() -> dict` → `{total_tokens:int, request_count:int, estimated_cost_usd:float|None, warnings:list[str], budget_tokens:int}` | DP-AGENT, DP-API, DP-UI (via JSON) |
| 15 | `record_golden()` | DP-MODEL | `src/stayquiet/model.py` | `def record_golden(cache_key: str, text: str) -> None` | DP-DEPLOY (`scripts/record_golden.py`) |
| 16 | `ThreadFit` (TypedDict) + `fit_thread()` | DP-MODEL | `src/stayquiet/context_bridge.py` | `{messages:list[dict], dropped:int, tokens:int, degraded:bool}` · `def fit_thread(messages: list[dict], max_tokens: int) -> ThreadFit` | DP-TOOLS |
| 17 | `contextFit` node bridge | DP-MODEL | `engine/bridge/context_fit.ts` | stdin JSON `{messages, maxTokens}` → stdout JSON `{messages, dropped, tokens}` | `fit_thread()` only |
| 18 | `emit()` | DP-STREAM | `src/stayquiet/publish.py` | `def emit(step_id: str, status: str, payload: dict, *, trace_id: str, degraded: bool = False) -> dict` — returns the envelope it published; never raises | DP-TOOLS, DP-AGENT, DP-API |
| 19 | `new_trace_id()` | DP-STREAM | `src/stayquiet/publish.py` | `def new_trace_id() -> str` (uuid4 string) | DP-AGENT, DP-API |
| 20 | `envelopes()` | DP-STREAM | `src/stayquiet/publish.py` | `def envelopes(trace_id: str | None = None) -> list[dict]` — sequence-sorted | DP-API |
| 21 | `snapshot()` | DP-STREAM | `src/stayquiet/publish.py` | `def snapshot(trace_id: str | None = None) -> dict` → `FallbackSnapshot` shape of §2.3 | DP-API |
| 22 | `since()` | DP-STREAM | `src/stayquiet/publish.py` | `def since(sequence: int, trace_id: str | None = None) -> list[dict]` — every envelope with `sequence > sequence`, sequence-sorted; the SSE route polls this | DP-API |
| 23 | `RunRecord`, `Decision` (TypedDicts) | DP-STREAM | `src/stayquiet/store.py` | see DP-STREAM §3 | DP-AGENT, DP-API, DP-UI (via JSON) |
| 24 | `create_run()`, `finish_run()`, `get_run()`, `latest_run()`, `list_runs()` | DP-STREAM | `src/stayquiet/store.py` | see DP-STREAM §3 | DP-AGENT, DP-API |
| 25 | `add_decision()`, `list_decisions()`, `get_decision()`, `resolve_decision()` | DP-STREAM | `src/stayquiet/store.py` | see DP-STREAM §3 | DP-AGENT, DP-API |
| 26 | `AuditEntry` (TypedDict), `audit_append()`, `audit_read()`, `AUDIT_PATH` | DP-STREAM | `src/stayquiet/audit.py` | `def audit_append(action: str, booking_id: str, detail: str, *, trace_id: str, degraded: bool = False) -> AuditEntry` · `def audit_read(limit: int = 200) -> list[AuditEntry]` | DP-TOOLS, DP-API |
| 27 | `ALL_TOOLS` | DP-TOOLS | `engine/tools/__init__.py` | `ALL_TOOLS: list` — the six `@tool` callables in fixed order | DP-AGENT, DP-DEPLOY |
| 28 | `policy_fetch`, `policy_diff`, `booking_lookup`, `clause_lookup`, `checklist_baseline`, `audit_log` | DP-TOOLS | `engine/tools/*.py` | signatures in DP-TOOLS §3 (all deterministic, all return JSON-serializable dicts, all `@tool`-decorated, none of them calls a model) | DP-AGENT |
| 29 | `set_trace()`, `current_trace()`, `note_tool_call()`, `drain_tool_calls()` | DP-TOOLS | `engine/tools/ctx.py` | `def set_trace(trace_id: str) -> None` · `def current_trace() -> str` · `def note_tool_call(name: str) -> None` · `def drain_tool_calls() -> list[str]` — module-level trace holder and tool-call recorder the tools use to tag envelopes and let the agent report which tools the loop actually chose | DP-AGENT |
| 30 | `CycleParams`, `CycleResult` (TypedDicts) | DP-AGENT | `engine/agents/stayquiet_agent.py` | see DP-AGENT §3 | DP-API |
| 31 | `run_cycle()` | DP-AGENT | `engine/agents/stayquiet_agent.py` | `def run_cycle(params: CycleParams | None = None) -> CycleResult` — synchronous, never raises | DP-API, DP-DEPLOY, DP-SCRIPT |
| 32 | `create_app()` / `app` | DP-API | `src/stayquiet/api.py` | `def create_app() -> FastAPI`; `app = create_app()` | DP-DEPLOY, DP-UI (dev proxy) |
| 33 | `STEP_LABELS` | DP-UI | `src/stayquiet/web/labels.ts` | `Record<string,string>` keyed by the §2.3 `step_id` vocabulary | DP-UI only |

#### §2.4b Consumed from pre-existing modules (never re-implemented)

| # | Import line to copy verbatim | Provided by | Used by |
|---|---|---|---|
| C1 | `from src.resilience import with_resilience, is_degraded_result, create_golden_cache` | resilience module | DP-MODEL, DP-DATA |
| C2 | `from src.resilience import DegradedResult, ResilienceConfig` | resilience module | DP-MODEL |
| C3 | `from src.cost import with_cost_guardrail, get_default_store` | cost module | DP-MODEL |
| C4 | `from src.cost import BudgetWarning, CostBudgetConfig, CostMeteringOpts` | cost module | DP-MODEL |
| C5 | `from src.platform.transport.event_envelope import EventEnvelope` | platform/transport | DP-STREAM |
| C6 | *(none)* — `src/platform/transport/stream_router.py` is marked ILLUSTRATIVE WIRING in its own header and is **not** imported by this entry. DP-API writes the SSE route itself over `since()` (row 22), so there is no async-from-sync hazard. | — | — |
| C7 | `import type { EventEnvelope } from "src/platform/transport/event-envelope.js";` — **type only, and from the generated module, never the barrel** | platform/transport | DP-UI |
| C8 | *(none)* — `useEventStream` / `createSubscriber` are unusable in a browser (Node builtins in their graph, `ajv` in their validation). DP-UI owns a ~25-line `EventSource` subscription instead; see DP-UI §0 and §5.4a. | — | — |
| C9 | `import { StepStatusIndicator, StreamingTextRenderer, CitationDisplay, isDegradedEnvelope, resolveTheme, currentTheme } from "src/platform/ui";` | platform/ui | DP-UI |
| C10 | `import { fit, count, countBuffer } from "src/context/index.js";` | context module | DP-MODEL (`engine/bridge/context_fit.ts` only) |
| C11 | `import { generateRecords, generateDocuments } from "src/data/index.js";` | data module | DP-DATA (`scripts/generate_fixtures.mjs` only) |
| C12 | `python -m src.provenance.provo.cli generate …` | provenance/prov | DP-SUBMIT |
| C13 | `python -m src.provenance.submit.cli format …` / `… hygiene …` | provenance/submit | DP-SUBMIT |
| C14 | `python -m src.cost.cli --json` | cost | DP-SUBMIT, DP-SCRIPT |
| C15 | `npm run deckgen -- populate …` / `npm run script -- generate …` / `npm run faqdef -- generate …` / `npm run demodrive -- …` | ideation | DP-SUBMIT, DP-DEPLOY |

#### §2.4c Ownership rules that resolve the classic collisions

1. **Envelope emission has exactly one owner: `publish.py:emit()` (row 18).** Tools and the agent
   never touch `HUB`, never build an envelope dict inline, never call
   `stream_router.publish`. `sequence` is assigned only inside `emit()`.
2. **Model invocation has exactly one owner: `model.py` (rows 10-11).** `build_agent()` is the
   only place a Strands `Agent` or a `BedrockModel` is constructed; `run_agent()` is the only
   place an agent is invoked, and the only place `with_resilience` / `with_cost_guardrail` are
   applied. **The six tools are deterministic and contain no model call at all** — the Strands
   loop does the writing, the tools supply grounded facts and side effects. No file anywhere
   calls `boto3` directly.
3. **Fixture reading has exactly one owner: `seed.py` (rows 3–8).** Tools receive typed dicts;
   no plan opens a file under `fixtures/` directly.
4. **Audit writing has exactly one owner: `audit.py` (row 26).** The `audit_log` tool is a thin
   `@tool` shell over it plus one `emit()`.
5. **Run/decision state has exactly one owner: `store.py` (rows 23–25).** The agent creates runs
   and decisions; the API only reads them and calls `resolve_decision()`.
6. **`config/stayquiet.json` has exactly one reader: `load_app_config()` (row 2).** No plan reads
   the JSON file itself, and no plan hardcodes a value that lives in it.
7. **The `step_id` vocabulary in §2.3 is closed.** Adding a step means editing this blueprint,
   not inventing an id inside a plan.

### §2.5 Configuration surface (one file, one env override each)

`config/stayquiet.json` (owned by DP-FOUND, literal contents in DP-FOUND §5.2). Env overrides,
all optional: `STAYQUIET_MODEL_ID`, `AWS_REGION`, `STAYQUIET_DEMO_MODE` (`1` = offline/golden
only), `STAYQUIET_CYCLE_INTERVAL_S`, `GOLDEN_CACHE_DIR`, `PORT`, `PUBLIC_URL`, plus AWS
credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) read by boto3
itself. `TRANSPORT=sse` and `THEME=operator` are read by the pre-existing platform layer.

---

## §3 Design-plan map

Eleven plans, in execution order. Every plan is complete on its own; §2.4 is the only shared
contract. `DP-SCRIPT` is last (see §3b).

| # | ID | Title | Scope boundary (IN) | Interfaces owned (§2.4 rows) | Consumers | Depends on | Requirements its WUs must fulfil |
|---|---|---|---|---|---|---|---|
| 1 | **DP-FOUND** | Runtime foundations, config, licence | `pyproject.toml`, `requirements.txt`, `contracts/tokenizer-profiles.json`, `config/stayquiet.json`, `src/stayquiet/__init__.py`, `src/stayquiet/config.py`, `engine/__init__.py`, `engine/tools/__init__.py` (empty list placeholder), `src/index.ts` repair, `LICENSE`, `.env.example` | 1, 2 | all plans | — | SQ-F-14, SQ-N-06, SQ-N-08 |
| 2 | **DP-DATA** | Synthetic bookings + policy snapshots, diff and impact matching | `fixtures/synthetic/bookings.json`, `fixtures/synthetic/policy_snapshots/2026-08-01.json`, `…/2026-09-08.json`, `src/stayquiet/seed.py`, `scripts/generate_fixtures.mjs` | 3–8 | DP-TOOLS, DP-AGENT, DP-API | DP-FOUND | SQ-F-01, SQ-F-02, SQ-F-03, SQ-N-03, SQ-N-04 |
| 3 | **DP-MODEL** | Bedrock via Strands, resilience, cost metering, context bridge | `src/stayquiet/model.py`, `src/stayquiet/context_bridge.py`, `engine/bridge/context_fit.ts` | 9–17 | DP-TOOLS, DP-AGENT, DP-API, DP-DEPLOY | DP-FOUND | SQ-F-04, SQ-F-11, SQ-F-12, SQ-N-01, SQ-N-04 |
| 4 | **DP-STREAM** | Envelope emission, run/decision state, audit trail | `src/stayquiet/publish.py`, `src/stayquiet/store.py`, `src/stayquiet/audit.py` | 18–26 | DP-TOOLS, DP-AGENT, DP-API | DP-FOUND | SQ-F-07, SQ-F-08, SQ-F-10, SQ-N-05 |
| 5 | **DP-TOOLS** | The six deterministic Strands tools | `engine/tools/ctx.py`, `engine/tools/policy.py`, `engine/tools/bookings.py`, `engine/tools/clauses.py`, `engine/tools/checklists.py`, `engine/tools/auditing.py`, `engine/tools/__init__.py` (final) | 27–29 | DP-AGENT | DP-DATA, DP-MODEL, DP-STREAM | SQ-F-02, SQ-F-08, SQ-F-11 + supplies the grounding SQ-F-04/SQ-F-05 depend on |
| 6 | **DP-AGENT** | The Strands agent loop, triage gate, cycle orchestration | `engine/agents/stayquiet_agent.py`, `engine/agents/__init__.py`, `engine/prompts/system.stayquiet.md`, `engine/prompts/user.draft.md`, `engine/prompts/user.checklist.md`, `engine/schema/input.schema.json`, `engine/schema/output.schema.json`, `engine/agents/index.ts` deletion, `engine/agents/todo.agent.md` deletion | 30, 31 | DP-API, DP-DEPLOY, DP-SCRIPT | DP-TOOLS | SQ-F-03, SQ-F-04, SQ-F-05, SQ-F-06, SQ-F-09, SQ-N-02, SQ-N-04 |
| 7 | **DP-API** | FastAPI service: SSE, REST, SPA hosting, background scheduler | `src/stayquiet/api.py`, `src/stayquiet/__main__.py` | 32 | DP-UI, DP-DEPLOY | DP-AGENT, DP-STREAM | SQ-F-07, SQ-F-09, SQ-F-10, SQ-F-13 |
| 8 | **DP-UI** | The host-facing SPA: quiet monitor → decision ping → audit trail | `index.html` (rewrite), `src/stayquiet/web/main.tsx`, `App.tsx`, `QuietMonitor.tsx`, `DecisionPing.tsx`, `AuditTrail.tsx`, `api.ts` (incl. its own `subscribeEnvelopes()`), `labels.ts`, `stayquiet.css`, `vite.config.ts` (proxy) | 33 | — | DP-API | SQ-F-07, SQ-F-09, SQ-F-10, SQ-N-03, SQ-N-05 |
| 9 | **DP-DEPLOY** | Container, AWS App Runner public URL, golden-cache recording, offline capture, optional AgentCore | `Dockerfile`, `.dockerignore`, `scripts/record_golden.py`, `scripts/deploy-apprunner.sh`, `scripts/smoke.sh`, `deploy/agentcore/{main.py,requirements.txt,README.md}`, `fixtures/demodrive/click-script.json`, `fixtures/golden/*.json`, plus one added `package.json` script (`build:bridge`) | — | DP-SUBMIT, DP-SCRIPT | DP-API, DP-UI | SQ-F-13, SQ-N-01, SQ-N-02, SQ-N-06 |
| 10 | **DP-SUBMIT** | README, architecture diagram, disclosure, submission copy, deck + Q&A (outside the repo) | `README.md`, `engine/README.md`, `docs/architecture.md`, `docs/architecture.mmd`, `docs/architecture.png`, `ai_tools.json`, `disclosure.md`, `hygiene-report.md`; deletes `run_sweep.sh`, `models.json`, `engine/rag/`, `engine/voice/`, `docs/engine-guide.md`; writes `submission.md`, `deck/`, `qa/`, `builder-post.md` **outside** the repo | — | DP-SCRIPT | DP-DEPLOY | SQ-F-14, SQ-N-03, SQ-N-07 |
| 11 | **DP-SCRIPT** | The demo-video script — measured, outside the repo | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md` only | — | operator | DP-SUBMIT (i.e. everything) | SQ-N-02, SQ-N-07 + §0.3 axis coverage |

### §3a Inter-module boundary rule

§2.4 plus this map is what keeps eleven independently-implemented plans consistent. The failure
mode being prevented is concrete and has happened before: one plan exports `emit()` while another
quietly writes its own envelope dict, so the UI receives two incompatible shapes and the stream
silently shows half the run. Therefore:

* Every cross-module function, type and file in this entry appears **exactly once** in §2.4 with
  its owning plan, file path, export name and shape.
* A plan's §2 OUT list names every file it must not create **and the plan that owns it**.
* A plan's §4 gives the literal import line, and the owning plan's §3 gives the literal
  signature — character for character identical.
* Where a work unit crosses a module boundary, its verification command **executes the real
  provider→consumer import** (e.g. DP-TOOLS WU-05's command imports `engine.tools` which imports
  `src.stayquiet.model`), so a mismatch fails immediately instead of at integration time.
* If an implementor finds something missing, the correct action is to stop and report, not to
  invent a local stub.

### §3b DP-SCRIPT is mandatory and last

The §3 map's last row, **DP-SCRIPT**, has one deliverable: the demo-video script. Its work units
run only after the product is built, because its first work unit executes the real product twice
with the exact demo parameters the video will use and harvests measured facts. Its requirements
are fixed by the DEMO-VIDEO SCRIPT CONTRACT, which is reproduced verbatim inside
`design_documents/design_plans/DP-SCRIPT.md` so its implementor needs no other file. **Single
owner:** no other plan may author the demo-video script. DP-DEPLOY may record, edit and upload
the video, and DP-SUBMIT may generate the Hour-0 draft `script.md` outside the repo, but the
spoken words come from DP-SCRIPT.

---

## §4 Submission checklist mapping

| Submission gate (§0.4) | Artifact | Produced by | Lives at |
|---|---|---|---|
| 1. Project built with Strands Agents | working application | DP-FOUND → DP-UI | entry repo |
| 2. Text description naming Strands explicitly | `submission.md` (fields to paste) | DP-SUBMIT WU-05 | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/submission.md` |
| 3. Public repo URL + MIT licence file visible in About | `LICENSE` (MIT) | DP-FOUND WU-04 | entry repo root |
| 4. README in the repo | `README.md` (product README, no shared-infrastructure paragraph) | DP-SUBMIT WU-01 | entry repo root |
| 5. Architecture diagram, labels required | `docs/architecture.md` + `docs/architecture.mmd` | DP-SUBMIT WU-02 | entry repo `docs/` |
| 6. Demo video ≤5:00, public | **script + slide prompts** | **DP-SCRIPT** | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md` |
| 6. (recording aid) | golden-path capture, video/screenshots | DP-DEPLOY WU-06 | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture/` |
| 7. Track selection | "Professional Agents" stated in `submission.md` + README | DP-SUBMIT | — |
| 8. AWS Builder ID | operator field, listed as a gap marker in `submission.md` | DP-SUBMIT WU-05 | — |
| 9. Live demo link (optional, scoring) | App Runner HTTPS URL | DP-DEPLOY WU-04 | printed by `scripts/deploy-apprunner.sh` |
| 10. Bonus blog post (optional) | draft post | DP-SUBMIT WU-07 (optional) | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/builder-post.md` |
| Rules: disclose pre-existing code | `disclosure.md` | DP-SUBMIT WU-03 (generator) | entry repo root |
| Rules: repo hygiene / no secrets | `hygiene-report.md` | DP-SUBMIT WU-06 | entry repo root |
| Judge Q&A defence (not submitted, operator aid) | `qa-sheet.md` | DP-SUBMIT WU-08 | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/qa/` |
| Pitch deck (not submitted, operator aid) | `deck/` | DP-SUBMIT WU-08 | `../../hackathons/hackathon-projects/2026-09-agents_for_humans/deck/` |

**Repository contents policy (binding, SQ-N-07).** The entry repo root may contain only:
application source (`src/`, `engine/`, `deploy/`, `scripts/`, `fixtures/`, `contracts/`,
`config/`, `docs/`, `index.html`), tests, build/deploy config (`pyproject.toml`,
`requirements.txt`, `package.json`, `tsconfig.json`, `vite.config.ts`, `Dockerfile`),
`README.md`, `LICENSE`, `disclosure.md`, `hygiene-report.md`, and `design_documents/`.
Everything else — deck, demo-video script, Q&A sheet, capture artifacts, submission copy,
blog-post draft — is written to `../../hackathons/hackathon-projects/2026-09-agents_for_humans/`.
When a pre-existing tool defaults to writing into the repo root, the plan MUST pass an explicit
`--out` into that folder.

**README policy (binding).** `README.md` is a product README: what StayQuiet does, who it is
for, the track, the stack, how to run it, the hosted URL, the licence. It must NOT contain a
"prior work" / "scaffolded from" paragraph, must NOT name or link any chassis / starter /
boilerplate repository, and must NOT list which shared directories were copied in. Originality
disclosure belongs in `disclosure.md`.

**disclosure.md policy (binding).** Generated by the disclosure generator, which already renders
capability sentences rather than a catalogue. A plan may APPEND event-specific sections (AI
usage, data provenance, runtime proofs) and must not rewrite the generated part or reintroduce
what it removes: no repository name, no module id, no requirement code, no directory listing.
Appended sections follow the same rule — describe capabilities, state what is new work.

---

## §5 Risks and the degraded-demo fallback ladder

### §5.1 Risk register

| # | Risk | Likelihood | Impact | Mitigation (owning plan) |
|---|---|---|---|---|
| R1 | `strands-agents` install or import fails / API differs from the pinned version | med | fatal (mandate) | DP-FOUND WU-02 verifies the import as its own work unit, before any code depends on it; version pinned in `requirements.txt`; DP-MODEL isolates every Strands touchpoint in two functions (`run_agent`, `build_agent`) so an API delta is a one-file fix |
| R2 | Bedrock model access not enabled / credentials missing / throttled | high | demo blocked | `with_resilience` + golden cache (DP-MODEL); `STAYQUIET_DEMO_MODE=1` runs the whole product offline from `fixtures/golden/` (DP-MODEL WU-05) |
| R3 | AWS App Runner deploy fails or costs escalate | med | loses optional live link only | DP-DEPLOY WU-04 is explicitly non-blocking; ladder rung 2 below; `$50` credit guard is the cost meter (DP-MODEL) |
| R4 | Node↔Python context bridge unavailable in the container | med | small | `fit_thread()` degrades to a deterministic newest-first message trim and stamps `degraded:true` (DP-MODEL WU-04) |
| R5 | SSE blocked by a proxy | low | demo looks frozen | the frontend's three-second `/api/state` poll carries the same `events` array, so the run still fills in; `GET /events` serves the same snapshot for any other client (DP-API WU-03) |
| R6 | Fixture generation needs `OPENAI_API_KEY` we do not want at build time | high | blocks DP-DATA | The three fixture files are authored **literally in DP-DATA §5**, committed, and are the source of truth; `scripts/generate_fixtures.mjs` is an optional regeneration path, never a build dependency |
| R7 | Video overruns 5:00 and the close is cut | med | Presentation points | DP-SCRIPT budgets to ~4:40 of speech with counted words and a measured read-aloud check |
| R8 | Script quotes numbers the build does not produce | med | credibility | DP-SCRIPT WU-01 harvests every fact from two real runs before a word is written |
| R9 | Implementor invents a duplicate of a cross-module export | med | disconnected code | §2.4 single-owner table + each plan's OUT list + cross-boundary verification commands |
| R10 | Repo leaks a secret or a real person's data | low | rules failure | Synthetic-only fixtures (SQ-N-03), `.gitignore` already covers credential patterns, DP-SUBMIT WU-06 runs the hygiene scan and blocks on `flagged` |
| R11 | Scope overrun with 4 days left | high | nothing ships | Plans 1–8 are the product and are ordered so that after DP-AGENT (plan 6) a runnable CLI demo already exists; plans 9–11 are packaging |

### §5.2 Degraded-demo fallback ladder (rehearse top to bottom, stop at the first that works)

1. **Live** — App Runner public URL, live Bedrock inference, SSE streaming. Full marks.
2. **Live-local** — `python -m src.stayquiet` on the operator's laptop at `localhost:8080`, live
   Bedrock. Loses only the hosted-link bullet.
3. **Degraded-live** — same as (2) with `STAYQUIET_DEMO_MODE=1`: every model call is served from
   `fixtures/golden/`, the UI shows the degraded badge, and the voiceover says so. Still a real
   end-to-end run of the real agent loop.
4. **Recorded golden path** — the `demodrive` capture in
   `../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture/` cut into the video.
5. **Non-streaming localhost** — `TRANSPORT=none`, `GET /events` snapshot only; the UI renders the
   complete run at once. Proves the product works with no live transport at all.

Rung 3 is rehearsed and recorded **before** the video is shot, so the guaranteed-visible artifact
(the public YouTube video) exists even if AWS is unreachable on the day.
