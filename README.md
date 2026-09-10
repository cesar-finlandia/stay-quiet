# StayQuiet

**A background agent for independent short-stay hosts.** It watches the platform's policy text and
your bookings, drafts what you would have written, and pings you only when a refund, an exception or
a review risk is actually yours to decide.

Built with the **Strands Agents SDK for Python** on **Amazon Bedrock**.
Track: **Professional Agents**.

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
