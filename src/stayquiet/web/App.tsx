// StayQuiet UI — the app shell: header, decision ping or quiet monitor, audit, footer.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";
import {
  EMPTY_STATE,
  fetchState,
  resolveDecision,
  startRun,
  subscribeEnvelopes,
} from "./api.js";
import type { AppState, StreamStatus } from "./api.js";
import { AuditTrail } from "./AuditTrail.js";
import { DecisionPing } from "./DecisionPing.js";
import { QuietMonitor } from "./QuietMonitor.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { AmbientField } from "./widgets.js";

/** The wordmark glyph — the beacon, frozen. Same construction as QuietBeacon. */
function Wordmark(): JSX.Element {
  return (
    <svg className="sq-wordmark__glyph" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="39" height="39" rx="11" fill="currentColor" opacity="0.1" />
      <circle cx="20" cy="20" r="13" stroke="currentColor" strokeWidth="1.2" opacity="0.35" />
      <circle cx="20" cy="20" r="8" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <circle cx="20" cy="20" r="3.4" fill="currentColor" />
    </svg>
  );
}

function IconInfo(): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.4" />
      <path d="M10 9.2v4.2" />
      <circle cx="10" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Stable content key: sequence/trace/timestamp differ every cycle, the rest
 *  identifies what the host actually sees. Two envelopes with the same key are
 *  the same entry shown twice. */
function envelopeContentKey(env: EventEnvelope): string {
  try {
    return `${env.step_id}\n${env.status}\n${JSON.stringify(env.payload ?? null)}`;
  } catch {
    return `${env.step_id}\n${env.status}`;
  }
}

/** Max streamed envelopes kept in a long-lived tab. The scheduler emits ~30
 *  per cycle, so 300 covers several cycles without growing forever. */
const MAX_STREAM_ENVELOPES = 300;

export function App(): JSX.Element {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [envs, setEnvs] = useState<EventEnvelope[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    const unsubscribe = subscribeEnvelopes({
      onEnvelope: (env) => {
        setEnvs((prev) => {
          if (prev.some((e) => e.sequence === env.sequence)) return prev;
          // Same entry already shown (re-emitted by a later identical cycle):
          // do not add a duplicate.
          const key = envelopeContentKey(env);
          if (prev.some((e) => envelopeContentKey(e) === key)) return prev;
          const next = [...prev, env].sort((a, b) => a.sequence - b.sequence);
          return next.length > MAX_STREAM_ENVELOPES
            ? next.slice(next.length - MAX_STREAM_ENVELOPES)
            : next;
        });
      },
      onStatus: (s) => setStreamStatus(s),
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      const s = await fetchState();
      if (alive) {
        setState(s);
        setLoaded(true);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const envelopes = envs.length > 0 ? envs : state.events;

  const onResolve = async (id: string, action: "approve" | "edit", text?: string): Promise<void> => {
    setBusyId(id);
    try {
      await resolveDecision(id, action, text);
      setState(await fetchState());
    } finally {
      setBusyId(null);
    }
  };

  // "Run a cycle now" is the one click in the app whose result is not immediate:
  // the POST returns as soon as the cycle is accepted, and the work then arrives
  // over the stream. runBusy keeps the working widget up from the click until
  // either the backend reports a cycle running or ~2.5s have passed, so the host
  // is never looking at a button that appears to have done nothing.
  const onRunNow = async (): Promise<void> => {
    setRunBusy(true);
    try {
      await startRun();
      setState(await fetchState());
    } finally {
      setTimeout(() => setRunBusy(false), 2500);
    }
  };

  const hasPending = state.decisions.some((d) => d.status === "pending");
  const working = runBusy || state.cycle_running;

  const monitor = (
    <QuietMonitor
      envelopes={envelopes}
      state={state}
      streamStatus={streamStatus}
      onRunNow={() => void onRunNow()}
      working={working}
      loaded={loaded}
    />
  );
  const ping = (
    <DecisionPing
      decisions={state.decisions}
      onResolve={(id, a, t) => void onResolve(id, a, t)}
      busyId={busyId}
    />
  );

  return (
    <>
      <AmbientField />
      <div className="sq-shell">
        <header className="sq-header">
          <div className="sq-header__top">
            <div className="sq-wordmark">
              <Wordmark />
              <div>
                <h1>StayQuiet</h1>
                <span className="sq-wordmark__tag">Quiet by default</span>
              </div>
            </div>
            <ThemeToggle />
          </div>
          <p className="sq-header__lede">
            A background agent for independent short-stay hosts. It watches policy changes and your
            bookings, drafts what you would have written, and only asks when the decision is yours.
          </p>
          <div className="sq-header__meta">
            <span className="sq-badge">
              Professional Agents · Strands Agents SDK for Python on Amazon Bedrock
            </span>
            {state.config.demo_mode ? (
              <span className="sq-badge sq-badge--outline sq-badge--mono">recorded demo</span>
            ) : null}
          </div>
          <p className="sq-synthetic">
            <IconInfo />
            <span>
              Every booking, guest and policy page here is synthetic demo data. No real person&apos;s
              information appears in this app.
            </span>
          </p>
        </header>

        <div className="sq-columns">
          <div className="sq-col">{hasPending ? ping : monitor}</div>
          <div className="sq-col sq-col--rail">{hasPending ? monitor : ping}</div>
        </div>

        <AuditTrail entries={state.audit} />

        <footer className="sq-footer">
          <span className="sq-footer__item">
            <span className="sq-footer__k">Model</span>
            <span className="sq-footer__v">{state.config.model_id || "—"}</span>
          </span>
          <span className="sq-footer__item">
            <span className="sq-footer__k">Region</span>
            <span className="sq-footer__v">{state.config.region || "—"}</span>
          </span>
          <span className="sq-footer__item">
            <span className="sq-footer__k">Cycle</span>
            <span className="sq-footer__v">every {state.config.cycle_interval_s}s</span>
          </span>
          <span className="sq-footer__item">
            <span className="sq-footer__k">Tokens</span>
            <span className="sq-footer__v">{state.cost.total_tokens.toLocaleString("en-GB")}</span>
          </span>
          <span className="sq-footer__item">
            <span className="sq-footer__k">Cost</span>
            <span className="sq-footer__v">
              {state.cost.estimated_cost_usd !== null && state.cost.estimated_cost_usd !== undefined
                ? `$${state.cost.estimated_cost_usd}`
                : "—"}
            </span>
          </span>
          <span className="sq-footer__item sq-muted">Estimated, not billed.</span>
        </footer>
      </div>
    </>
  );
}
