// StayQuiet UI — the audit trail: newest first, never truncated.
import type { JSX } from "react";
import type { AuditEntry } from "./api.js";
import { IconLedger } from "./widgets.js";

export type AuditTrailProps = {
  entries: AuditEntry[];
};

function hhmmss(at: string): string {
  try {
    return String(at).slice(11, 19);
  } catch {
    return "";
  }
}

export function AuditTrail(props: AuditTrailProps): JSX.Element {
  const { entries } = props;
  // Dedupe: the background cycle re-emits the same audit lines every few
  // minutes, so an identical action+booking+detail already shown is not added
  // again. Keeps the first (newest) occurrence; timestamps/entry_ids differ.
  const seen = new Set<string>();
  const unique = entries.filter((a) => {
    const key = `${a.action}\n${a.booking_id}\n${a.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    return (
      <section className="sq-card" aria-label="Audit trail">
        <div className="sq-card__head">
          <h2 className="sq-card__title">
            <IconLedger />
            Audit trail
          </h2>
        </div>
        <p className="sq-empty">Nothing logged yet.</p>
      </section>
    );
  }
  return (
    <section className="sq-card" aria-label="Audit trail">
      <div className="sq-card__head">
        <h2 className="sq-card__title">
          <IconLedger />
          Audit trail
        </h2>
        <span className="sq-badge sq-badge--outline sq-badge--mono">
          {unique.length} entries · append-only
        </span>
      </div>
      {/* The dispute-defence view: nothing is paginated and no detail is
          truncated, so a scroll container keeps the page navigable without
          hiding a single line. It prints in full (see the @media print rule). */}
      <div className="sq-audit__scroll">
        <dl className="sq-audit">
          {unique.map((a) => (
            <div
              key={a.entry_id}
              className={`sq-audit__row${a.degraded ? " sq-degraded-row" : ""}`}
            >
              <dt>
                <time className="sq-audit__time" dateTime={a.at}>
                  {hhmmss(a.at)}
                </time>
              </dt>
              <dd>
                <code className="sq-audit__action">{a.action}</code>
              </dd>
              <dd className="sq-audit__detail">
                {a.booking_id ? <span className="sq-audit__booking">{a.booking_id}</span> : null}
                {a.detail}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
