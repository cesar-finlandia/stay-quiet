# Provenance & Disclosure

> Generated from the assembly manifest — do not hand-edit accuracy; polish wording only if needed.

## Reused prior code

For this hackathon I reused **5** pre-existing block(s) of code that handle infrastructure-level functionality, none of them specific to this project:

- a wrapper that retries a slow or failed provider call and falls back to a cached response, so a live demo never dead-ends on a blank screen
- a typed event-streaming bus for pushing step-by-step progress to the browser, plus a one-command deploy helper and a small themed UI shell
- a message buffer that keeps a conversation inside a model's context window, with a pluggable token counter
- a generator for synthetic demo records that stamps every row as synthetic
- code that counts token and request usage and warns before a configured budget is exceeded, to prevent overspending

Thus all application-level code, and most other low-level code, was designed and implemented only for this hackathon.

The repository also contains a small amount of pre-existing developer tooling used to prepare this submission's documents. The application does not call it at runtime and it is not part of the product.

## How this entry was built

The workflow was: design plans authored with Claude AI from my project idea, then implemented using cheaper AI models. Testing was done with Claude as well.

## AI assistance

- **Claude Opus 5 (Anthropic)** — authored the design plans this project was built from, and reviewed and amended them to resolve implementation conflicts
- **Muse Spark (Meta, via OpenCode)** — implemented the application code from those design plans and verified each work unit

_Generated at 2026-09-10T09:31:39.305Z from manifest hash 73a09a46920ba719e89a49faa59f1d4478bfaf3fce8eb8edea607f523a51f829._

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
