// StayQuiet UI — display labels for the closed step_id vocabulary (blueprint row 33).
// Keys are exactly the twelve step ids in blueprint §2.3; adding a key here without
// adding the step id there is a bug.
export const STEP_LABELS: Record<string, string> = {
  cycle: "Background cycle",
  policy_fetch: "Reading the policy page",
  policy_diff: "Comparing it with last month",
  booking_scan: "Finding affected bookings",
  booking_lookup: "Reading the booking and its messages",
  clause_lookup: "Quoting the current policy text",
  checklist_baseline: "Checking what may still be required",
  draft_reply: "Drafting the reply",
  turnover_checklist: "Building the turnover checklist",
  triage: "Deciding whether to ask you",
  audit_write: "Writing the audit trail",
  decision_resolved: "Your decision recorded",
};

/** Human label for a decision kind. */
export const KIND_LABELS: Record<string, string> = {
  refund: "Refund decision",
  exception: "Policy exception",
  review_risk: "Review risk",
};
