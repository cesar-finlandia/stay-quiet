// Requirement IDs: UI-01, UI-02, UI-05, UI-REU-01, UI-RES-01, UI-RES-02 | DP-B §6.1c, §7.1, §7.2
// CitationDisplay — source / citation reference display (UI-01c). Consumes any
// envelope carrying payload[payloadKey] (default "citations") or payload.sources
// arrays — the envelope stays domain-agnostic; the domain puts citations there.
// Envelope-only runtime data (UI-05); standalone (UI-02); copy via props with
// defaults (UI-REU-01).
import type { EventEnvelope } from "src/platform/transport";
import { degradedResultOf, isDegradedEnvelope } from "./isDegraded.js";

export type Citation = { title: string; url?: string; snippet?: string };

export type CitationDisplayProps = {
  envelopes: EventEnvelope[]; // filters to payload.citations or payload.sources
  payloadKey?: string; // default "citations"; configurable per domain
  emptyText?: string;
  title?: string;
  className?: string;
};

const DEFAULT_PAYLOAD_KEY = "citations";
const DEFAULT_EMPTY_TEXT = "Sources will appear after synthesis."; // UI-RES-01 §7.1

function asCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  const out: Citation[] = [];
  for (const entry of value) {
    if (typeof entry === "object" && entry !== null) {
      const e = entry as Record<string, unknown>;
      const title = typeof e["title"] === "string" ? e["title"] : "";
      if (title === "") continue;
      out.push({
        title,
        url: typeof e["url"] === "string" ? e["url"] : undefined,
        snippet: typeof e["snippet"] === "string" ? e["snippet"] : undefined,
      });
    }
  }
  return out;
}

export function CitationDisplay(props: CitationDisplayProps) {
  const {
    envelopes,
    payloadKey = DEFAULT_PAYLOAD_KEY,
    emptyText = DEFAULT_EMPTY_TEXT,
    title,
    className,
  } = props;

  const ordered = [...envelopes].sort((a, b) => a.sequence - b.sequence);

  // Collect citations across all envelopes in sequence order; each envelope may
  // carry payload[payloadKey] or payload.sources (domain's choice). Degraded
  // payloads are skipped here — their data renders via the banner only.
  const citations: Citation[] = [];
  for (const e of ordered) {
    if (isDegradedEnvelope(e)) continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    citations.push(...asCitations(payload[payloadKey]));
    if (payloadKey !== "sources") citations.push(...asCitations(payload["sources"]));
  }

  // Degraded banner (UI-RES-02 §7.2), shared treatment across components.
  const degradedEnvelope = ordered.find(isDegradedEnvelope);
  const degraded = degradedEnvelope ? degradedResultOf(degradedEnvelope) : null;

  // Empty / pre-event state (UI-RES-01 §7.1): icon + placeholder before data
  // arrives — never crashes, never renders nothing.
  const isEmpty = citations.length === 0 && !degraded;
  const rootClass = ["ui-citations", isEmpty ? "ui-citations--empty" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass} data-empty={isEmpty ? "true" : undefined}>
      {title ? <div className="ui-citations__title">{title}</div> : null}
      {degraded ? (
        <div className="degraded-banner" role="status" aria-live="polite">
          <span className="degraded-badge">{degraded.fallback_source}</span>
          <span className="degraded-reason">{degraded.reason}</span>
          {degraded.data != null ? (
            <pre className="degraded-data">{JSON.stringify(degraded.data)}</pre>
          ) : null}
        </div>
      ) : null}
      {isEmpty ? (
        <p className="ui-citations__placeholder">
          <span className="ui-citations__icon" aria-hidden="true" />
          {emptyText}
        </p>
      ) : (
        <ul className="ui-citations__list">
          {citations.map((c, i) => (
            <li key={`${i}:${c.title}`} className="ui-citation">
              {c.url ? (
                <a className="ui-citation__link" href={c.url}>
                  {c.title}
                </a>
              ) : (
                <span className="ui-citation__title">{c.title}</span>
              )}
              {c.snippet ? <span className="ui-citation__snippet">{c.snippet}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
