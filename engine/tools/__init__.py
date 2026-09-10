# StayQuiet Strands tools — the closed set the agent loop may choose from
# (blueprint §2.4 row 27). Order is fixed: it is the order the tools appear in the
# agent's tool list and therefore in its system prompt.
from engine.tools.auditing import audit_log
from engine.tools.bookings import booking_lookup
from engine.tools.checklists import checklist_baseline
from engine.tools.clauses import clause_lookup
from engine.tools.ctx import current_trace, drain_tool_calls, note_tool_call, set_trace
from engine.tools.policy import policy_diff, policy_fetch

ALL_TOOLS: list = [
    policy_diff,
    policy_fetch,
    booking_lookup,
    clause_lookup,
    checklist_baseline,
    audit_log,
]

__all__ = [
    "ALL_TOOLS",
    "audit_log",
    "booking_lookup",
    "checklist_baseline",
    "clause_lookup",
    "current_trace",
    "drain_tool_calls",
    "note_tool_call",
    "policy_diff",
    "policy_fetch",
    "set_trace",
]
