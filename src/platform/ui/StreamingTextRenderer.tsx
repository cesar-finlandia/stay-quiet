// Requirement IDs: UI-01, UI-02, UI-05, UI-REU-01, UI-RES-01, UI-RES-02, TRN-05, TRN-RES-03 | DP-B §6.1b, §7.1–§7.3
// StreamingTextRenderer — streaming text / output renderer (UI-01b). Consumes
// payload.delta chunks (TRN-05) concatenated in sequence order while streaming;
// on status:"done" renders payload.text atomically (also the non-streaming
// fallback visual per TRN-RES-03 §7.3 — same component, no second mode).
// Envelope-only runtime data (UI-05); standalone (UI-02); copy via props with
// defaults (UI-REU-01).
import type { EventEnvelope } from "src/platform/transport";
import { degradedResultOf, isDegradedEnvelope } from "./isDegraded.js";

export type StreamingTextRendererProps = {
  envelopes: EventEnvelope[]; // filters to status:"streaming"/"done" envelopes
  stepId?: string; // optional: filter to one step_id; if absent, renders latest step
  emptyText?: string; // UI-RES-01 fallback before streaming starts
  degradedText?: string; // UI-RES-02 degraded banner copy (prop, not hardcode)
  showCursor?: boolean; // blinking cursor during streaming
  className?: string;
};

const DEFAULT_EMPTY_TEXT = "Response will appear here…"; // UI-RES-01 §7.1

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function StreamingTextRenderer(props: StreamingTextRendererProps) {
  const {
    envelopes,
    stepId,
    emptyText = DEFAULT_EMPTY_TEXT,
    degradedText,
    showCursor = false,
    className,
  } = props;

  const scoped = stepId ? envelopes.filter((e) => e.step_id === stepId) : envelopes;

  // Degraded banner (UI-RES-02 §7.2) takes visual precedence; the underlying
  // DegradedResult.data (if any) is surfaced in the banner's pre block.
  const degradedEnvelope = [...scoped].sort((a, b) => a.sequence - b.sequence).find(isDegradedEnvelope);
  const degraded = degradedEnvelope ? degradedResultOf(degradedEnvelope) : null;

  // Latest step's text state: concatenate delta chunks by sequence while
  // streaming; a done envelope with payload.text replaces it atomically.
  let streaming = false;
  let done = false;
  const deltas: string[] = [];
  let finalText: string | null = null;

  for (const e of [...scoped].sort((a, b) => a.sequence - b.sequence)) {
    if (isDegradedEnvelope(e)) continue; // degraded data renders via banner only
    if (e.status === "started") continue;
    if (e.status === "streaming") {
      streaming = true;
      deltas.push(asText((e.payload ?? {})["delta"]));
    } else if (e.status === "done") {
      const text = asText((e.payload ?? {})["text"]);
      if (text !== "") {
        done = true;
        finalText = text;
      }
    }
  }

  // Empty / pre-event state (UI-RES-01 §7.1): faint placeholder line.
  if (!done && !streaming && deltas.length === 0 && !degraded) {
    return (
      <div className={"ui-stream-text ui-stream-text--empty".concat(className ? ` ${className}` : "")} data-empty="true">
        <p className="ui-stream-text__placeholder">{emptyText}</p>
      </div>
    );
  }

  const body = done && finalText !== null ? finalText : deltas.join("");
  const isStreamingNow = !done && streaming;

  return (
    <div
      className={"ui-stream-text".concat(className ? ` ${className}` : "")}
      data-status={done ? "done" : isStreamingNow ? "streaming" : "idle"}
    >
      {degraded ? (
        <div className="degraded-banner" role="status" aria-live="polite">
          <span className="degraded-badge">{degraded.fallback_source}</span>
          <span className="degraded-reason">
            {degraded.reason}
            {degradedText ? ` ${degradedText}` : ""}
          </span>
          {degraded.data != null ? (
            <pre className="degraded-data">{JSON.stringify(degraded.data)}</pre>
          ) : null}
        </div>
      ) : null}
      <p className="ui-stream-text__body">
        {body}
        {isStreamingNow && showCursor ? <span className="ui-stream-text__cursor" aria-hidden="true" /> : null}
      </p>
    </div>
  );
}
