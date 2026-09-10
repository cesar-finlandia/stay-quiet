// StayQuiet UI — the decision ping: one card per pending decision, approve or edit.
import { useState } from "react";
import type { JSX } from "react";
import { KIND_LABELS } from "./labels.js";
import type { Decision } from "./api.js";
import {
  ExposureMeter,
  IconCheck,
  IconPencil,
  WorkingWidget,
} from "./widgets.js";

export type DecisionPingProps = {
  decisions: Decision[];
  onResolve: (id: string, action: "approve" | "edit", text?: string) => void;
  busyId: string | null;
};

const METER_TONE: Record<string, "refund" | "exception" | "risk"> = {
  refund: "refund",
  exception: "exception",
  review_risk: "risk",
};

// Approving posts, waits for the audit write, then re-polls — a second or two on
// a good day. These lines say what that second is being spent on, because the
// host is being asked to trust an append-only record they cannot see being written.
const FILING_REEL = [
  "Recording your decision against this booking…",
  "Writing the append-only audit entry…",
  "Filing the reply and the clause it was grounded in…",
];

export function DecisionPing(props: DecisionPingProps): JSX.Element {
  const { decisions, onResolve, busyId } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>("");

  const pending = decisions.filter((d) => d.status === "pending");
  const resolved = decisions.filter((d) => d.status !== "pending");

  if (pending.length === 0) {
    return (
      <section className="sq-panel" aria-label="Needs your decision">
        <div className="sq-panel__head">
          <h2 className="sq-card__title">Needs your decision</h2>
        </div>
        {resolved.length === 0 ? (
          <p className="sq-empty">
            <span>Nothing is waiting on you.</span>
            <span className="sq-muted">Decisions you resolve will be listed here.</span>
          </p>
        ) : (
          <ul className="sq-resolved">
            {resolved.slice(0, 3).map((d) => (
              <li key={d.decision_id}>
                <span className="sq-resolved__tick">
                  <IconCheck size={13} />
                </span>
                <span className="sq-resolved__name">{d.guest_name}</span>
                <span className="sq-muted">{KIND_LABELS[d.kind] ?? d.kind}</span>
                <span className="sq-resolved__when">
                  {(d.resolved_at ?? d.created_at).slice(11, 19)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="sq-card" aria-label="Needs your decision">
      <div className="sq-card__head">
        <h2 className="sq-card__title">Needs your decision</h2>
        <span className="sq-badge sq-badge--mono">
          {pending.length} waiting
        </span>
      </div>

      <div className="sq-decisions">
        {pending.map((d, i) => {
          const busy = busyId === d.decision_id;
          const maxExposure = Math.max(...pending.map((p) => p.modelled_exposure_eur), 1);
          return (
            <article
              key={d.decision_id}
              className="sq-decision"
              data-kind={d.kind}
              style={{ ["--sq-i" as string]: String(i) }}
            >
              <div className="sq-decision__top">
                <div>
                  <span className="sq-decision__kind">{KIND_LABELS[d.kind] ?? d.kind}</span>
                  <div className="sq-decision__who">
                    <span className="sq-decision__guest">{d.guest_name}</span>
                    <span>{d.listing_name}</span>
                    <span className="sq-chip">{d.booking_id}</span>
                  </div>
                  <p className="sq-decision__summary">{d.summary}</p>
                </div>

                <div className="sq-exposure">
                  <span className="sq-exposure__label">Modelled exposure</span>
                  <ExposureMeter
                    value={d.modelled_exposure_eur}
                    max={maxExposure}
                    tone={METER_TONE[d.kind] ?? "refund"}
                  />
                  <span className="sq-exposure__note">
                    Modelled, not billed: a weighting of this booking&apos;s payout by decision
                    type.
                  </span>
                </div>
              </div>

              {d.clause_ids.length > 0 ? (
                <div className="sq-decision__section">
                  <span className="sq-decision__label">Policy clauses behind this</span>
                  <div className="sq-chips">
                    {d.clause_ids.map((c) => (
                      <span key={c} className="sq-chip">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="sq-decision__section">
                <span className="sq-decision__label">Drafted reply</span>
                <blockquote className="sq-draft-text">{d.draft_text}</blockquote>
              </div>

              {d.checklist.length > 0 ? (
                <div className="sq-decision__section">
                  <span className="sq-decision__label">Turnover checklist</span>
                  <ul className="sq-checklist">
                    {d.checklist.map((item, k) => (
                      <li key={k}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {d.degraded ? (
                <p className="sq-decision__section">
                  <span className="sq-degraded">Degraded — served from the recorded cache</span>
                </p>
              ) : null}

              <div className="sq-actions">
                <button
                  type="button"
                  className="sq-btn sq-btn--primary"
                  disabled={busy}
                  onClick={() => onResolve(d.decision_id, "approve")}
                >
                  <IconCheck />
                  Approve and file
                </button>
                <button
                  type="button"
                  className="sq-btn sq-btn--secondary"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(d.decision_id);
                    setEditText(d.draft_text);
                  }}
                >
                  <IconPencil />
                  Edit before filing
                </button>
              </div>

              {editingId === d.decision_id ? (
                <div className="sq-edit">
                  <span className="sq-decision__label">Your wording</span>
                  <textarea
                    className="sq-edit-box"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={7}
                    aria-label="Edit the drafted reply before filing"
                  />
                  <div>
                    <button
                      type="button"
                      className="sq-btn sq-btn--primary"
                      disabled={busy}
                      onClick={() => onResolve(d.decision_id, "edit", editText)}
                    >
                      <IconCheck />
                      Save my wording
                    </button>
                  </div>
                </div>
              ) : null}

              {busy ? (
                <WorkingWidget
                  title="Filing your decision"
                  reel={FILING_REEL}
                  tone="ember"
                  variant="inline"
                />
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
