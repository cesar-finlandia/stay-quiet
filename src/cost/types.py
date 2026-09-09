# Requirement IDs: COST-01, COST-02, COST-03, COST-RES-01, COST-REU-02, RES-03
"""Cost guardrail value types — DP-I §4.1–§4.4.

Python mirror of the TypeScript shapes frozen in design_documents/design_plans/
DP-I-cost-usage-guardrail.md §4 (field names/types are frozen there). Snake_case
only; provider-agnostic (COST-REU-02); zero chassis imports (COST-REU-01) so this
module stays importable standalone. No tokenizer logic lives here (COST-REU-02).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Dict, Literal, NotRequired, Optional, TypedDict

BudgetUnit = Literal["tokens", "requests", "estimated_cost"]
"""Unit a budget is expressed in — DP-I §4.3 (`BudgetUnit`)."""

BudgetWarningLevel = Literal["warning", "critical"]
"""warning fires at threshold, critical at critical_threshold — DP-I §4.4."""


class BudgetScope(TypedDict, total=False):
    """One scope's cap — DP-I §4.3 (`BudgetScope`). Only `budget` is required."""

    budget: float  # positive number — max allowed in units of `unit`
    unit: BudgetUnit  # default "tokens"
    threshold: float  # 0..1 fraction at which warning fires — default 0.8 (DP-I §6)
    critical_threshold: Optional[float]  # optional second threshold for level=critical
    label: str  # optional human label for summary header


class CostBudgetConfig(TypedDict, total=False):
    """COST-02 config — DP-I §4.3. Validated by contracts/cost-budget.schema.json.

    The first property is the JSON key "global" (a Python keyword), declared via
    the functional TypedDict form below to keep the contract name verbatim.
    """


CostBudgetConfig = TypedDict(  # noqa: F811 — functional form keeps JSON key "global"
    "CostBudgetConfig",
    {
        "global": BudgetScope,  # checked against CostStore.global_totals()
        "per_provider": Dict[str, BudgetScope],  # key = provider name lowercased
    },
    total=False,
)


# --- extended below: CostMeteringOpts, UsageRecord, ProviderTotals, BudgetWarning ---

if TYPE_CHECKING:  # COST-REU-01: store type referenced by name only, never imported
    from typing import Protocol

    class CostStore(Protocol):  # pragma: no cover — structural stub for annotations
        """Structural stand-in for src/cost/store.py CostStore (added in a later step)."""


# Partial<UsageRecord> | null — the usageExtractor return shape (DP-I §4.1).
PartialUsageRecord = Optional[Dict[str, Any]]


class CostMeteringOpts(TypedDict, total=False):
    """Wrapper config — DP-I §4.1 (`CostMeteringOpts`). provider/label required."""

    provider: str  # required, non-empty — metering group key
    label: str  # required, non-empty — caller label (ADV, DATA, agent, EVAL...)
    model_profile: str  # optional — forwarded to CTX-02; default: provider-derived
    budget_config: CostBudgetConfig  # optional — per-wrapper budget override
    store: "CostStore"  # optional — injection; default get_default_store()
    on_warning: Callable[["BudgetWarning"], Any]  # optional callback per §3.5
    usage_extractor: Callable[[Any], PartialUsageRecord]  # optional provider usage passthrough
    estimate_cost_per_1k_tokens: float  # optional — USD per 1k tokens for estimated_cost unit


class UsageRecord(TypedDict):
    """One metered call — DP-I §4.2 (`UsageRecord`). COST-01/COST-RES-01.

    At least one of input_tokens/output_tokens/request_count should be present;
    when all token fields are null, `unmetered` is True (never throws).
    """

    id: str  # uuid v4, assigned at record time
    timestamp: str  # ISO-8601 of call completion
    provider: str  # lowercased, trimmed provider tag
    label: str  # caller label as supplied
    model_profile: str  # resolved profile used for counting
    input_tokens: Optional[int]  # via CTX-02 count or provider usage field
    output_tokens: Optional[int]  # via CTX-02 or provider usage field
    total_tokens: Optional[int]  # input + output (computed if both present, else supplied)
    request_count: int  # always 1 per record (one call == one request)
    estimated_cost_usd: Optional[float]  # total/1000 * estimate_cost_per_1k_tokens if supplied
    unmetered: bool  # true if counts could not be derived (COST-RES-01)
    unmetered_reason: str  # e.g. missing_usage_data, malformed_provider_usage, empty_provider_tag
    raw_usage_ref: Any  # opaque ref to original provider usage object (not persisted by default)


class ProviderTotals(TypedDict):
    """Aggregated scope totals — DP-I §4.2 (`ProviderTotals`)."""

    provider: str  # "_global" for global scope
    total_input_tokens: int
    total_output_tokens: int
    total_tokens: int  # sum of non-null totals; unmetered records contribute 0
    request_count: int  # count of records including unmetered — attempts are counted
    estimated_cost_usd: Optional[float]  # sum where available, else null
    unmetered_count: int  # how many records in this scope were unmetered


class BudgetWarning(TypedDict):
    """Pure-data warning signal — DP-I §4.4 (`BudgetWarning`). COST-03/RES-03.

    No stack trace, no exception, no throw — callers branch on scope/level/
    utilization. `message` is pre-formatted for direct logger.warn consumption.
    """

    scope: str  # "global" or provider name (e.g. "openai")
    level: BudgetWarningLevel  # which threshold was crossed
    threshold: float  # the threshold fraction that was crossed (e.g. 0.8)
    budget: float  # configured budget for this scope
    unit: BudgetUnit  # unit of budget
    cumulative: float  # current cumulative in that unit (e.g. total_tokens)
    utilization: float  # cumulative / budget (0..1+, may exceed 1.0)
    remaining: float  # budget - cumulative (may be negative after overshoot)
    provider_totals: NotRequired[ProviderTotals]  # snapshot for this scope at warning time
    timestamp: str  # ISO-8601 of warning emission
    message: str  # human line e.g. "[COST] openai at 82% (8200/10000 tokens) — threshold 80%"
    once_per_threshold: bool  # true — emission is edge-triggered per §3.5
