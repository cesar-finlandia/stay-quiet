# cost — Cost & Usage Guardrail (COST)

<!-- Requirement IDs: COST-01..04, COST-RES-01, COST-REU-01, COST-REU-02, XCUT-06, NONGOAL-11 -->

## Purpose

> **⚠ Disclaimer — local estimate only, not billing.**
> This module tracks *estimated* token/request usage locally for the developer's own protection. It is **not** a billing, invoicing, or payment system and must **not** be presented to end users or judges as an authoritative cost figure without independent verification against the provider's own dashboard (see `NONGOAL-11`). Treat the summary table and any `BudgetWarning` as a developer convenience, not a verified quote.

The Cost & Usage Guardrail meters LLM calls made through any `RES-REU-02`
callable: it derives token counts (reusing `CTX-02`'s counter, never its own
tokenizer), accumulates `UsageRecord`s in a session-local store, checks
cumulative usage against configured budgets, emits edge-triggered
`BudgetWarning`s when a threshold is crossed, and renders a human-readable
summary table. It never blocks the wrapped call (`GOV-RES-04`): metering is a
side-effect that always lets the inner result through.

Public surface (import only from `src/cost`, never internals):

- `with_cost_guardrail(fn, opts=None)` — the metering wrapper (sync or async callables).
- `create_cost_store(...)` / `get_default_store()` — session store; `CostStore` type.
- Value types: `UsageRecord`, `ProviderTotals`, `BudgetWarning`,
  `CostBudgetConfig`, `CostMeteringOpts`, `BudgetScope`, `BudgetUnit`.

## Configuration

Budgets and thresholds are supplied per call via `CostMeteringOpts` — no code
change inside the module (`GOV-RES-02`). The two required tags are
`provider` (billing grouping key, lowercased at store time) and `label`
(caller label such as `ADV`, `DATA`, `agent`, `EVAL`). Adding a provider or
label is a call-site edit only.

Budget config shape (`CostBudgetConfig`, see `contracts/cost-budget.schema.json`):

```python
{
    "global": {"budget": 1000000, "unit": "tokens", "threshold": 0.8},
    "per_provider": {
        "acme-llm": {"budget": 30000, "unit": "requests", "threshold": 0.8},
        # optional second stage:
        "widget-ai": {"budget": 400000, "unit": "tokens",
                       "threshold": 0.8, "critical_threshold": 0.95},
    },
}
```

- `unit` is one of `tokens | requests | estimated_cost`; default `tokens`
  because heuristic counting guarantees a value even without provider-reported
  usage (`COST-REU-02`). `estimated_cost` requires an explicit caller-supplied
  rate (`estimate_cost_per_1k_tokens`) and remains a local multiplication, not
  a verified quote.
- Global and per-provider checks are independent; a scope with no budget entry
  is tracked in the summary but never warned (`Budget: —`).
- Default threshold is **0.8** — rationale pointer: DP-I §6.1/§10 (80% matches
  the chassis-wide `warning_threshold: 0.8` convention, leaves ~4h of headroom
  at typical burn rates, and keeps the warning inside the ±15% heuristic error
  band before any hard cap).

Configuration vectors, lowest to highest precedence:

1. Checked-in defaults: `src/cost/defaults.json`.
2. Optional file `config/cost.json` (shape = `CostBudgetConfig`) if present in
   the working copy — mirrors the `config/context.json` convention. It is
   **optional**: the chassis works without it, and it is not part of this repo
   by default (checked in per event only if wanted, `GOV-REU-01`).
3. Store-level config passed to `create_cost_store(budget_config=...)` or
   `store.set_budget_config(cfg)`.
4. Per-wrapper override via `CostMeteringOpts.budget_config` (per-scope wins).
5. Environment overrides — highest precedence, for mid-event changes without a
   code edit:

   | Env var | Effect |
   |---|---|
   | `COST_GLOBAL_BUDGET` | Overrides `global.budget` (numeric string) |
   | `COST_GLOBAL_THRESHOLD` | Overrides `global.threshold` (e.g. `0.8`) |
   | `COST_PROVIDER_BUDGET_<PROVIDER>` | e.g. `COST_PROVIDER_BUDGET_ACME_LLM=30000` |
   | `COST_WARN_CALLBACK=1` | Route warnings to `console.warn` automatically |

## Example

Every figure shown below is a **local estimate — not billing; verify against
provider dashboard** (`NONGOAL-11`).

Quick start — wrap any callable (sync or async):

```python
# Requirement IDs: COST-01, COST-03, COST-04
from src.cost import with_cost_guardrail, get_default_store

store = get_default_store()

call_llm = with_cost_guardrail(
    lambda prompt: call_provider(prompt),          # any RES-REU-02 callable
    provider="acme-llm",
    label="agent",
    model_profile="generic-heuristic",             # forwarded to CTX-02 counting
    budget_config={"global": {"budget": 1000000, "unit": "tokens", "threshold": 0.8}},
    on_warning=lambda w: print(w["message"]),      # e.g. "[COST] global at 82% ..."
)

result = call_llm("hello")                          # inner value returned unwrapped
print(store.render_summary())                       # summary table + disclaimer footer
```

A rendered summary is illustrative only; all numbers are local estimates — not
billing; verify against provider dashboard:

```text
== Cost & Usage Summary (local estimate — not billing; verify against provider dashboard) ==
provider     requests   input tok   output tok   total tok   unmetered
acme-llm          14       18200        11400       29600           0
widget-ai          5        6100         2300        8400           1
_global           19       24300        13700       38000           1
[BUDGET] global: 38000/1000000 tokens (3.8%) — threshold 80%
```

### Composition with resilience (RES-01) — order-independent (`DP-I §3.2`)

Both orders are valid; they differ only in what gets counted:

```python
# Order A — cost OUTSIDE resilience (recommended):
metered = with_cost_guardrail(
    with_resilience(fetch_widget, resilience_config), cost_opts
)
# each retry attempt is metered separately → accurate cost reflection

# Order B — cost INSIDE resilience:
resilient = with_resilience(
    with_cost_guardrail(fetch_widget, cost_opts), resilience_config
)
# one count per logical call → retries are not individually metered
```

Order A is the default recommendation: it reflects the true number of provider
attempts. Neither order requires changes inside the resilience or context
packages.

### Integration with Resilience (`RES-03`) — caller-side patterns (`DP-I §3.6`)

`src/cost/` never imports the resilience package (`COST-REU-01`). The integration is
a pattern in **caller code** (Engine / agent loop), shown here for reference —
it lives outside this module:

```python
# Caller-side integration — NOT part of src/cost/:
from src.cost import with_cost_guardrail, get_default_store
import with_resilience  # sibling RES package import — caller side only

store = get_default_store()
budget = {"global": {"budget": 1000000, "unit": "tokens", "threshold": 0.8}}

# Option A — on_warning flag: flip subsequent calls to a cache/replay fallback
metered = with_cost_guardrail(
    lambda: call_provider(prompt),
    provider="acme-llm", label="agent", budget_config=budget,
    on_warning=lambda w: set_cost_fallback_active(w["scope"]),
)

# Option B — pre-composed chain: fallback already present, warning informational
safe_call = with_resilience(
    with_cost_guardrail(lambda: call_provider(prompt),
                        provider="acme-llm", label="agent"),
    {"fallback_chain": {"order": ["cache", "replay", "none"]}},
)

# Option C — pre-call gate: consult the store before issuing the next call
if any(w["level"] == "exceeded" for w in store.check_budget(budget)):
    result = serve_from_cache()          # skip the provider call entirely
else:
    result = metered()
```

The warning is observable **before the next** provider call (the check runs
synchronously after each record append); the current call is never
retroactively blocked (`GOV-RES-04`). Warnings are edge-triggered — once per
threshold crossing per scope — so repeated calls above the same threshold do
not spam.

### Import boundary (`DP-I §8.1/§8.4`)

Consumers import **only** the package entry point — never internals:

```python
from src.cost import with_cost_guardrail, create_cost_store, get_default_store
from src.cost import UsageRecord, CostBudgetConfig, BudgetWarning  # value types
```

Deep imports such as `from src.cost.meter import derive_token_counts` or
`from src.cost.config import ...` are forbidden and lint-failed. Inside the
package, the only allowed intra-chassis import is `src/context/token_counter`
(`COST-REU-02`); the package imports no sibling chassis code — not the
resilience, platform, media, or assembly packages, nor any other.

## What this does not contain:

- No billing, invoicing, or payment logic — local estimation only (`NONGOAL-11`).
- No provider price table or billing API integration — cost conversion is a local multiplication of CTX-02-derived token counts by a caller-supplied rate, not a verified quote.
- No authoritative spend claim — every figure is an estimate; verify against the provider's own dashboard. Never present guardrail output to users or judges as a verified cost without that check.
- No cross-event or cross-tenant accounting — session-local only.
- No domain-specific thresholds, copy, or prior-hackathon spend data — all content under `/examples/dummy-fixtures/`, excluded from working copy via `ASM-02`.

