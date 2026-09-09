# Requirement IDs: COST-01, COST-02, COST-03, COST-RES-01, COST-REU-01, COST-REU-02
"""Cost & Usage Guardrail — public package boundary (DP-I §8.1/§8.4).

Curated runtime + value-type surface: consumers import ONLY from src.cost —
never internals like derive_token_counts (DP-I §8.4).
"""

from .types import (
    BudgetScope,
    BudgetUnit,
    BudgetWarning,
    BudgetWarningLevel,
    CostBudgetConfig,
    CostMeteringOpts,
    PartialUsageRecord,
    ProviderTotals,
    UsageRecord,
)
from .store import CostStore, create_cost_store, get_default_store
from .meter import with_cost_guardrail

__all__ = [
    "BudgetScope",
    "BudgetUnit",
    "BudgetWarning",
    "BudgetWarningLevel",
    "CostBudgetConfig",
    "CostMeteringOpts",
    "CostStore",
    "PartialUsageRecord",
    "ProviderTotals",
    "UsageRecord",
    "create_cost_store",
    "get_default_store",
    "with_cost_guardrail",
]
