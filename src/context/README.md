# context — Context & Conversation Buffer Manager (CTX)

## Purpose

Bookkeeping over message sequences: token counting, budget arithmetic, and
mechanical truncation for multi-turn conversation buffers. The module answers
one question — *does this buffer fit, and if not, what is the smallest
deterministic set of messages to drop?* It never retries failed calls and never
talks to a provider; failure recovery is the resilience module's job (its
optional integration point is described under *What This Does Not Contain*).

Public surface (import only from `src/context/index.ts`):

- `fit(buffer, config)` / `append(buffer, message, config)` — fitted buffer + `BufferStatus`.
- `calcStatus` / `calcBudget` — status snapshot and `input_budget = max(0, context_window - reserved_output)`.
- `count` / `countBuffer` — single source of truth for token counting (also consumed by COST).
- Adapters: `registerAdapter` / `getAdapter` / `listAdapters` (`openai-chat`, `anthropic-messages`, `generic` built in).
- Strategies: `registerStrategy` (`sliding-window-pinned`, `keep-last-n` built in).
- Extension point: `registerCompaction` / `fitWithCompaction` (CTX-05) — a slot for an Engine-supplied compaction function.

## Configuration

All knobs live in `ContextBudgetConfig` per call (`GOV-RES-02`) — no code change,
no redeploy:

| Field | Default | Effect |
|---|---|---|
| `model_profile` | `"generic-heuristic"` | Key into `contracts/tokenizer-profiles.json`; selects tokenizer scheme + default `context_window`. Unknown profile → warn + generic-heuristic. |
| `context_window` | from profile | Explicit override wins over the profile map (test-only or new models). |
| `reserved_output` | `1024` | Tokens reserved for generation; subtracted once. |
| `strategy` | `"sliding-window-pinned"` | Also `keep-last-n`; unknown → warn + default. |
| `strategy_options` | `{}` | Per-strategy knobs, e.g. `{ n: 4 }`. |
| `warning_threshold` | `0.8` | `utilization >= threshold` → `warning:"approaching"`. |
| `critical_threshold` | `0.95` | `utilization >= critical` or over budget → `warning:"exceeded"`. |
| `mutate` | `false` | `false` = side-effect-free (new arrays); `true` allows in-place truncation. |
| `compaction` | `null` | CTX-05 slot; `null` = mechanical strategies only. |

File-level defaults ship in `src/context/defaults.json`; an optional
`config/context.json` can override them globally without code edits (it may also
extend the tokenizer profile map inline via `{ "profiles": { ... } }`).

Registration extension points — add a provider wire format with
`registerAdapter({ id, toProvider, fromProvider })`, add a mechanical truncation
policy with `registerStrategy(...)`, or plug an exact tokenizer scheme with
`registerTokenizer(name, fn)` plus a profile-map entry. Registration is config-
adjacent, never an edit inside `src/`.

## Worked Example

```ts
// sample-buffer: a JSON array of messages loaded from the repo's dummy
// fixture tree (see "No domain corpus" below) — never a src/ import.
import { fit } from "src/context/index.js";

const result = fit(sampleBuffer, {
  model_profile: "generic-heuristic",
  context_window: 200,   // tiny window so the demo truncates deterministically
  reserved_output: 20,   // input_budget = 180 tokens
  strategy: "sliding-window-pinned",
});

result.buffer;         // fitted buffer — pinned system prompt kept, oldest turns evicted
result.status;         // { total_tokens <= 180, truncated: true, evicted_count, warning, ... }
```

On the checked-in fixture (7 Acme Corp/widget messages, pinned system first) the
result keeps the pinned system entry, drops the oldest evictable turns until the
sum fits 180 heuristic tokens, sets `truncated: true`, and reports the eviction
count in `status.evicted_count`. A second call returns a byte-identical result.

## What This Does Not Contain

- **No LLM prompt.** The chassis ships zero summarization/compaction prompts
  (`NONGOAL-07`). CTX-05 is a typed slot (`CompactionFn`); whatever prompt it
  runs is supplied by the Engine at registration time.
- **No domain corpus.** No RAG corpus, no domain ranking, no persona — mechanism
  only. All fixtures are synthetic Acme Corp/widget text under
  `examples/dummy-fixtures/context/` (`GOV-REU-02`).
- **No DegradedResult redefinition.** Failure/retry semantics belong to the
  resilience module; this module does not redefine or import them.
- **Optional RES-03 caller-side integration.** If a caller wants resilience on
  overflow, it checks `status.warning` around `fit()` itself and enters its own
  fallback chain — there is no chassis wiring between the two modules:
  `const r = fit(buf, cfg); if (r.status.warning === "exceeded") { /* caller's withResilience(...) */ }`
