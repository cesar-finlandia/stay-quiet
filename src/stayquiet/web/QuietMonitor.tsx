// StayQuiet UI — the quiet monitor: beacon, progress, latest draft, citations, run strip.
import type { JSX } from "react";
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";
import { CitationDisplay } from "src/platform/ui/CitationDisplay.js";
import { StepStatusIndicator } from "src/platform/ui/StepStatusIndicator.js";
import { STEP_LABELS } from "./labels.js";
import type { AppState } from "./api.js";
import {
  IconPlay,
  IconShield,
  QuietBeacon,
  QuietWorkBar,
  SkeletonLines,
  Stat,
  WorkingWidget,
} from "./widgets.js";

export type QuietMonitorProps = {
  envelopes: EventEnvelope[]; // live stream envelopes, or state.events as fallback
  state: AppState;
  streamStatus: string; // "connecting" | "open" | "closed" | "error"
  onRunNow: () => void;
  /** true from the moment "Run a cycle now" is clicked until the cycle settles. */
  working?: boolean;
  /** false until the first /api/state poll returns, so we show skeletons not voids. */
  loaded?: boolean;
};

// Shown one at a time inside the working widget while a cycle runs. Each line is
// a true statement about what the deterministic layer is doing, in the host's
// vocabulary — the point of the widget is that a wait is explained, not merely
// animated.
const CYCLE_REEL = [
  "Fetching the platform's current policy page…",
  "Comparing it clause by clause with last month's capture…",
  "Marking which changes touch money…",
  "Matching changed clauses to bookings you actually sold…",
  "Reading each affected booking and its recent messages…",
  "Drafting replies in your voice, grounded in the current text…",
  "Deciding what is yours to answer and what to file quietly…",
];

export function QuietMonitor(props: QuietMonitorProps): JSX.Element {
  const { envelopes, state, streamStatus, onRunNow, working = false, loaded = true } = props;
  const pending = state.decisions.filter((d) => d.status === "pending").length;

  const ordered = [...envelopes].sort((a, b) => a.sequence - b.sequence);
  const draftEnvs = ordered.filter((e) => e.step_id === "draft_reply" && e.status === "done");
  const latestDraft: EventEnvelope | null = draftEnvs.at(-1) ?? null;
  const latestDraftPayload =
    latestDraft !== null && typeof latestDraft.payload === "object" && latestDraft.payload !== null
      ? (latestDraft.payload as Record<string, unknown>)
      : null;
  const latestDraftText =
    latestDraftPayload !== null && typeof latestDraftPayload["text"] === "string"
      ? (latestDraftPayload["text"] as string)
      : "";
  const latestDraftDegraded = latestDraft !== null && latestDraft.degraded === true;

  // The live sub-step for the working widget: whatever the newest envelope is
  // doing, in the same words the step rail uses. Falls back to the reel.
  const newest = ordered.at(-1) ?? null;
  const liveStep =
    newest !== null && newest.status !== "done"
      ? (STEP_LABELS[newest.step_id] ?? newest.step_id) + "…"
      : null;

  // Only envelopes that actually carry citations reach the CitationDisplay: it
  // renders its degraded banner when ANY envelope in its list is degraded, so
  // handing it the full stream would print a lone "none" badge whenever an
  // unrelated step (e.g. a degraded draft) degraded. A degraded clause_lookup
  // that still carries citations keeps its banner through the same rule.
  const citationEnvs = ordered.filter((e) => {
    if (typeof e.payload !== "object" || e.payload === null) return false;
    const p = e.payload as Record<string, unknown>;
    return (
      (Array.isArray(p["citations"]) && p["citations"].length > 0) ||
      (Array.isArray(p["sources"]) && p["sources"].length > 0)
    );
  });

  const dotClass =
    streamStatus === "open"
      ? "sq-dot--open"
      : streamStatus === "connecting"
        ? "sq-dot--connecting"
        : streamStatus === "error"
          ? "sq-dot--error"
          : "sq-dot--closed";

  const run = state.run;

  return (
    <>
      {pending === 0 ? (
        <section className="sq-quiet sq-anim-rise" aria-label="Quiet state">
          <QuietBeacon active={working} />
          <div>
            <h2 className="sq-quiet__title">Nothing needs you</h2>
            <p className="sq-quiet__body">
              The agent is running in the background. It will ping you only for a refund, an
              exception, or a review risk.
            </p>
            {run?.summary ? <p className="sq-quiet__summary">{run.summary}</p> : null}
          </div>
        </section>
      ) : null}

      <section className="sq-panel" aria-label="Quiet monitor">
        <div className="sq-panel__head">
          <h2 className="sq-card__title">
            <IconShield />
            What the agent is doing
          </h2>
          <span className="sq-stream">
            <span
              className={`sq-dot ${dotClass}`}
              title={streamStatus}
              aria-label={`Stream ${streamStatus}`}
            />
            {streamStatus}
          </span>
        </div>

        {working ? (
          <WorkingWidget
            title="Running a background cycle"
            detail={liveStep}
            reel={CYCLE_REEL}
            tone="brand"
          />
        ) : null}

        {!loaded ? (
          <div style={{ marginTop: "var(--sq-space-4)" }}>
            <SkeletonLines lines={4} />
          </div>
        ) : null}

        <StepStatusIndicator
          envelopes={envelopes}
          labelMap={STEP_LABELS}
          title="What the agent is doing"
          emptyText="Waiting for the next background cycle…"
          showSequence={false}
        />

        {/*
          No StreamingTextRenderer here. Nothing in this product ever emits a
          "streaming" status — draft_reply emits only "started" and "done" — so it
          could never render a partial draft. What it did render was a second copy
          of the degraded state (as the raw tokens "cache" / "served_from_golden_cache")
          above the figure below, which already shows the settled draft with the
          degraded chip in the host's own words.
        */}
        {latestDraftText ? (
          <figure className="sq-draft">
            <figcaption>
              Latest draft
              {latestDraftDegraded ? (
                // role="status" because the shared component's own degraded banner is
                // suppressed inside this panel (see stayquiet.css) — this chip is now
                // the announced one.
                <span className="sq-degraded" role="status">
                  Degraded — served from the recorded cache
                </span>
              ) : null}
            </figcaption>
            <blockquote>{latestDraftText}</blockquote>
          </figure>
        ) : null}

        <CitationDisplay
          envelopes={citationEnvs}
          title="Policy text this was grounded in"
          emptyText="No policy clause read yet."
        />

        {run ? (
          <>
            <div className="sq-stats" style={{ marginTop: "var(--sq-space-5)" }}>
              <Stat
                label="Worked"
                value={`${run.bookings_affected}/${run.bookings_scanned}`}
                hint="Bookings that needed work, out of every booking scanned"
                tone="ember"
              />
              <Stat
                label="Handled quietly"
                value={String(run.quiet_actions)}
                hint="Actions filed and logged without asking you"
                tone="brand"
              />
              <Stat
                label="Policy changes"
                value={String(run.changed_clauses.length)}
                hint="Clauses that differ from the previous capture"
              />
              <Stat
                label="Cycle time"
                value={`${(run.elapsed_ms / 1000).toFixed(1)}s`}
                hint={state.config.demo_mode ? "Recorded run" : "Live run"}
              />
            </div>
            <QuietWorkBar affected={run.bookings_affected} scanned={run.bookings_scanned} />
          </>
        ) : null}

        <div className="sq-actions">
          <button type="button" className="sq-btn sq-btn--brand" onClick={onRunNow} disabled={working}>
            <IconPlay />
            {working ? "Cycle running…" : "Run a cycle now"}
          </button>
        </div>
      </section>
    </>
  );
}
