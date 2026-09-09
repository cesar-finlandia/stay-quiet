<!-- Requirement IDs: RES-REU-01, XCUT-06, XCUT-08 -->

# src/resilience — Resilience & Demo-Proofing Layer

## Purpose

`src/resilience` is the single, self-contained reliability wrapper every fallible
step (LLM call, HTTP fetch, parser) goes through (`RES-01`). It turns transient
failures into either a successful value or an explicit `DegradedResult`, so a
live demo never shows a stack trace.

What it provides:

- **`withResilience` / `with_resilience`** — wraps an async callable with timeout,
  retry + backoff, and an ordered fallback chain
  (`secondary_provider → cache → replay → none`) (`RES-02`, `RES-03`).
- **`withResilienceSync`** — synchronous variant for sync call positions.
- **`withValidation` / `with_validation`** — validates structured output against
  a JSON schema and runs **exactly one** schema-repair pass via a repair LLM
  before failing over (`RES-04`).
- **Golden-path cache** (`createGoldenCache` / `create_golden_cache`) —
  content-addressed on-disk cache with a replay subspace for deterministic
  offline demos (`RES-05`).
- **Forced-degraded kill switch** — rehearse or rescue a demo by skipping live
  providers entirely (`RES-07`).
- The outermost guard: the wrapper itself **never throws** — worst case you get
  a `DegradedResult` (`RES-RES-03`).

Consumers import **only** from this package root (`RES-REU-01`):

```typescript
import { withResilience, withResilienceSync, withValidation, isDegradedResult,
         createGoldenCache, validate, repair } from "src/resilience";
import type { DegradedResult, ResilienceConfig, GoldenCache, ValidationError } from "src/resilience";
```

```python
from src.resilience import with_resilience, with_validation, is_degraded_result, \
    create_golden_cache, validate, repair, DegradedResult, ResilienceConfig
```

Deep imports into internals (`cache/store`, `config`, wrapper internals) are
forbidden and CI-checked.

## Configuration

All behavior is controlled by `ResilienceConfig` alone — no code changes, no
redeploy (`RES-07`, `GOV-RES-02`). Precedence (lowest → highest):
`defaults.json` → per-call `ResilienceConfig` → env vars.

| Knob | Config field | Default | Effect |
|---|---|---|---|
| Timeout per call | `timeout_ms` | `15000` | Abort primary/secondary/repair call after N ms; triggers retry if retries remain |
| Retry count | `retries` | `2` | Additional attempts beyond initial call; `0` = no retry |
| Backoff policy | `backoff.policy` | `"exponential"` | `exponential`/`linear`/`fixed`/`none` |
| Backoff base/factor/max/jitter | `backoff.*` | `250 / 2.0 / 5000 / true` | Per-attempt delays; `max_ms` caps; jitter ±25% uniform |
| Fallback order & enable | `fallback_chain.order` + per-step `enabled` | `["cache","replay","none"]` | Controls the fallback sequence; secondary disabled by default to avoid surprise provider billing |
| Cache-key strategy | `cache_key_strategy` | `"auto"` | `auto` = `sha256(provider\|model\|input_hash)`; `explicit` = caller-supplied key |
| Forced-degraded kill switch | `forced_degraded` | `false` | When `true`, primary + secondary are skipped; jumps straight to cache/replay/`DegradedResult` |

Environment-variable overrides (operator can flip mid-event without a code edit):

- `RES_FORCED_DEGRADED=1` — kill switch: skip live providers, serve cache/replay or degrade.
- `RES_TIMEOUT_MS`, `RES_RETRIES` — override the corresponding config fields.

**Measured latency overhead** (`RES-RES-01`, interim targets): wrapper overhead on the success path
with no retry is expected at **< 5 ms median, < 15 ms p95** (Node 20, Python 3.11);
CI warns if `p95 ≥ 20 ms` (warn-not-block until **BENCH-03** freezes the final
measured budget).

Measured on this repo (Node 24.17.0 / Python 3.12.13, 1000 paired samples per
DP-A §8.4, `overhead_ms = wrapped − raw` on the success path):

| harness | median | p95 | p99 |
| --- | --- | --- | --- |
| TypeScript (`withResilience`) | 0.003 ms | 0.006 ms | 0.025 ms |
| TypeScript (`withResilienceSync`) | ~0 ms | ~0 ms | — |
| Python (`with_resilience`, async) | 0.005 ms | 0.006 ms | 0.009 ms |
| Python (`with_resilience`, sync) | 0.002 ms | 0.002 ms | — |

All runs are far inside the interim target (< 5 ms median / < 15 ms p95) and the
CI guard (< 20 ms p95). Full report: `reports/bench/latency-overhead.json`
(re-run via `npx tsx src/resilience/scripts/bench-resilience-overhead.ts` or
`python src/resilience/scripts/bench_resilience_overhead.py`).

The repair pass inherits `timeout_ms`; give it `retries: 1` to avoid latency
amplification (`DP-A §6.2`). The repair LLM is supplied **out-of-band** via deps
(`repairLlm`), never serialized into config.

## Example

Adapted from the worked example in `DP-A §11.2/§11.3` (dummy Acme Corp/widget
endpoints — no real domain data).

```typescript
// Requirement IDs: RES-01, RES-02, RES-03, RES-05, RES-06
import { withResilience, isDegradedResult, createGoldenCache } from "src/resilience";

const cache = createGoldenCache(); // defaults to .cache/golden

// Primary: Acme Corp widget overview (dummy)
async function fetchWidgetOverview(): Promise<{ title: string; summary: string }> {
  const res = await fetch("https://api.acme.example/widgets/overview", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fetchWidgetOverviewSecondary(): Promise<{ title: string; summary: string }> {
  const res = await fetch("https://secondary.acme.example/widgets/overview");
  if (!res.ok) throw new Error(`secondary ${res.status}`);
  return res.json();
}

// Wrap — secondary supplied out-of-band via deps (never serialized into config)
const wrapped = withResilience(fetchWidgetOverview, {
  timeout_ms: 8000, retries: 1,
  fallback_chain: { order: ["secondary_provider", "cache", "replay", "none"] },
}, { secondaryProvider: fetchWidgetOverviewSecondary });

const result = await wrapped(); // value | DegradedResult — never throws

// Record golden path on success so future offline runs can replay it
if (!isDegradedResult(result)) {
  const key = cache.deriveKey({ provider: "acme", model: "widget-v1", prompt: { endpoint: "/widgets/overview" } });
  await cache.put(key, result, { provider: "acme", model: "widget-v1", source: "manual" });
}
```

Structured output + one-shot repair (`RES-04`):

```typescript
import { withValidation } from "src/resilience";

const schema = { type: "object", required: ["title", "summary"] };
const validated = withValidation(fetchWidgetOverview, schema,
                                 { /* ResilienceConfig */ },
                                 { repairLlm: (prompt) => callLlm(prompt) });
```

```python
# Python equivalent
# Requirement IDs: RES-01, RES-02
from src.resilience import with_resilience, is_degraded_result, create_golden_cache

cache = create_golden_cache()

def fetch_widget_overview():
    import requests
    r = requests.get("https://api.acme.example/widgets/overview", timeout=8)
    r.raise_for_status()
    return r.json()

wrapped = with_resilience(fetch_widget_overview, {
    "timeout_ms": 8000, "retries": 1,
    "fallback_chain": {"order": ["secondary_provider", "cache", "replay", "none"]},
})
result = await wrapped()  # value | DegradedResult
```

Recording the golden path and rehearsing fallback (`DP-A §11.3`):

```bash
# Record golden path for rehearsal (manual path)
npx ts-node src/resilience/scripts/record-golden.ts \
  --provider acme --model widget-v1 \
  --input examples/dummy-fixtures/resilience/prompt-overview.json \
  --output .cache/golden/tmp.json

# Rehearse fallback without breaking primary — kill switch
RES_FORCED_DEGRADED=1 npm run dev:smoke   # wrapper jumps to cache/replay
```

or per-call: `withResilience(fetchWidgetOverview, { forced_degraded: true,
fallback_chain: { order: ["cache", "replay", "none"] } })`. When forced-degraded
cache misses, the returned `DegradedResult` carries `reason: "forced_degraded"`
and the `fallback_source` actually used, so the UI can show a rehearsal
indicator (`UI-RES-02`).

## What this module does NOT contain

Per `DP-A §14` (Non-Goals Affirmation):

- **Domain prompts, personas, or business logic** — no product copy, no RAG
  ranking, no agent role definitions (`GOV-REU-02`, `NONGOAL-01`). The one
  self-repair prompt is generic error-path rendering (`§6.3`), not a domain
  instruction.
- **Multi-agent graph topology** — no Router→Specialist→Critic→Synthesizer
  runnable default (`NONGOAL-02`); the wrapper is step-agnostic (`TRN-REU-01`).
- **Pre-populated corpus / pre-generated dataset** — no checked-in real cache
  entries beyond `examples/dummy-fixtures/` synthetic `widget`/`Acme Corp`
  data (`NONGOAL-03/06/10`).
- **Voice dialogue policy or conversational scripts** — streaming/barge-in is
  `MED-TTS`'s concern (`NONGOAL-04`).
- **Hackathon-specific UI copy, branding, or themes** — only the
  `DegradedResult` discriminator contract; rendering belongs to `UI-RES-02`
  (`NONGOAL-05`).
- **Video editing, submission branding, or secret auto-remediation** — never
  trims, never rewrites history (`NONGOAL-13–16`).
- **Auto-orchestration** — never re-runs other tools, never schedules
  (`NONGOAL-15`).
- **Chassis-applicability gating** — mandated-platform flag is `PROFILE-06`'s
  concern; this layer never gates assembly (`NONGOAL-17`).
