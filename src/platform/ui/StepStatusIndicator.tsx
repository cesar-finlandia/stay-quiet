// Requirement IDs: UI-01, UI-02, UI-05, UI-REU-01, UI-RES-01, UI-RES-02 | DP-B §6.1a, §7.1, §7.2
// StepStatusIndicator — live step / status indicator (UI-01a). Envelope-only
// runtime data (UI-05): derives the current step from the LAST envelope's
// step_id and the badge from the 4-value status enum; handles N=1..∞ steps
// with no step-count assumption (TRN-REU-01). Standalone by construction
// (UI-02). All user-facing copy flows through props with defaults (UI-REU-01).
import type { EventEnvelope } from "src/platform/transport";
import { degradedResultOf, isDegradedEnvelope } from "./isDegraded.js";

export type StepStatusIndicatorProps = {
  envelopes: EventEnvelope[]; // consumed: TRN-01/02 only
  labelMap?: Record<string, string>; // UI-REU-01: step_id → display label (no hardcode)
  title?: string; // UI-REU-01: e.g. "Progress"
  emptyText?: string; // UI-REU-01: pre-event state (UI-RES-01)
  showSequence?: boolean; // debug toggle
  className?: string;
};

const STATUS_VALUES = ["started", "streaming", "done", "error"] as const;
type StatusValue = (typeof STATUS_VALUES)[number];

const DEFAULT_EMPTY_TEXT = "Awaiting progress…"; // UI-RES-01 §7.1

function isStatusValue(v: string): v is StatusValue {
  return (STATUS_VALUES as readonly string[]).includes(v);
}

export function StepStatusIndicator(props: StepStatusIndicatorProps) {
  const {
    envelopes,
    labelMap,
    title,
    emptyText = DEFAULT_EMPTY_TEXT,
    showSequence = false,
    className,
  } = props;

  // Empty / pre-event state (UI-RES-01 §7.1): skeleton badge + emptyText —
  // never crashes, never renders nothing.
  if (envelopes.length === 0) {
    return (
      <div className={"ui-step-status ui-step-status--empty".concat(className ? ` ${className}` : "")} data-empty="true">
        {title ? <div className="ui-step-status__title">{title}</div> : null}
        <span className="ui-badge ui-badge--skeleton" />
        <span className="ui-step-status__empty-text">{emptyText}</span>
      </div>
    );
  }

  // Ordered view of the run; last envelope wins for current step/status.
  const ordered = [...envelopes].sort((a, b) => a.sequence - b.sequence);
  const last = ordered[ordered.length - 1]!;
  const currentStepId = last.step_id;
  const currentStatus: StatusValue = isStatusValue(last.status) ? last.status : "started";

  const steps = new Map<string, EventEnvelope>();
  for (const e of ordered) steps.set(e.step_id, e);

  const labelFor = (stepId: string): string => labelMap?.[stepId] ?? stepId;

  // Degraded banner (UI-RES-02 §7.2): shared built-in treatment, only when an
  // envelope carries a DegradedResult per DP-A. No second error channel.
  const degradedEnvelope = ordered.find(isDegradedEnvelope);
  const degraded = degradedEnvelope ? degradedResultOf(degradedEnvelope) : null;

  return (
    <div
      className={"ui-step-status".concat(className ? ` ${className}` : "")}
      data-current-step={currentStepId}
      data-status={currentStatus}
    >
      {title ? <div className="ui-step-status__title">{title}</div> : null}
      <ol className="ui-step-status__steps">
        {[...steps.entries()].map(([stepId, env]) => {
          const status = isStatusValue(env.status) ? env.status : "started";
          const isCurrent = stepId === currentStepId;
          return (
            <li
              key={stepId}
              className={`ui-step ui-step--${status}${isCurrent ? " ui-step--current" : ""}`}
              data-step-id={stepId}
              data-status={status}
            >
              <span className={`ui-badge ui-badge--${status}`}>{status}</span>
              <span className="ui-step__label">{labelFor(stepId)}</span>
              {showSequence ? <span className="ui-step__sequence">#{env.sequence}</span> : null}
            </li>
          );
        })}
      </ol>
      {degraded ? (
        <div className="degraded-banner" role="status" aria-live="polite">
          <span className="degraded-badge">{degraded.fallback_source}</span>
          <span className="degraded-reason">{degraded.reason}</span>
          {degraded.data != null ? (
            <pre className="degraded-data">{JSON.stringify(degraded.data)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
