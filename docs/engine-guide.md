# Engine Guide — replacing the scaffolded stubs

TODO(ENGINE) markers in `<out>/engine/` are the hour-1 starting points for your
team (DP-G §4.3). The chassis assembles a **skeleton**, never an answer:
stubs are empty entry points wrapped by RES-01 so whatever you write inside
them is already timeout/retry/fallback-proof.

## What to replace

| File | Replace with |
|---|---|
| `engine/agents/__init__.py` / `engine/agents/index.ts` | Your real agent call. Keep the `with_resilience` / `withResilience` wrapper and its config (`timeout_ms: 15000, retries: 1, fallback_chain cache→none`) — replace only the inner function body. |
| `engine/prompts/system.todo.md`, `user.todo.md` | Domain system/user prompts you design. No persona is pre-written — that is deliberate (NONGOAL-01). |
| `engine/schema/input.schema.json`, `output.schema.json` | Real JSON Schemas for your Engine I/O. Output is validated via RES-04 once defined. |
| `engine/rag/corpus.todo.md` | Your RAG corpus. Never pre-populated by chassis (NONGOAL-03). |
| `engine/voice/policy.todo.md` | Your voice dialogue policy; chassis ships streaming mechanics only (NONGOAL-04). |

Rename files (drop `.todo`) as you fill them; keep the decorator wrappers.

## Rules

1. **Keep the RES-01 wrapper.** Config-only wrapping means your inner body can
   throw, hang, or return garbage without taking the demo down.
2. **No domain content is provided on purpose.** Personas, corpora, and graph
   topologies are hour-1 team decisions (NONGOAL-01..04).
3. **Re-runs preserve edits** (ASM-05): assembling again with more components
   never overwrites existing `engine/**` files — only missing stubs are added.
