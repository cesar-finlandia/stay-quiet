// StayQuiet UI — the vector widget set.
//
// Every widget here is hand-authored SVG + CSS. There is no animation library in
// the bundle, deliberately: DP-UI §2 forbids a new npm dependency, and the whole
// motion vocabulary is transform/opacity keyframes that a browser composites on
// the GPU without help. design_documents/visual_identity_plan.md §9 records the
// production stack (Framer Motion, Recharts, Atropos) that these primitives map
// onto one-for-one if that constraint is ever lifted.
//
// The rule the file exists to enforce: whenever a click does not produce an
// immediate result, a WorkingWidget appears, it moves, and it says in words what
// is being done and what the host should expect. No bare spinners.
import { useEffect, useState } from "react";
import type { JSX } from "react";

/* ───────────────────────────  Ambient background  ─────────────────────────── */

/**
 * Two slow-drifting colour washes and a grain plate, fixed behind the shell.
 * At 5–7% alpha they are invisible as "an effect" and only register as the page
 * having depth — which is the difference between a product and a form.
 */
export function AmbientField(): JSX.Element {
  return (
    <div className="sq-ambient" aria-hidden="true">
      <div className="sq-ambient__wash sq-ambient__wash--a" />
      <div className="sq-ambient__wash sq-ambient__wash--b" />
      <div className="sq-ambient__grain" />
    </div>
  );
}

/* ─────────────────────────────  Quiet beacon  ─────────────────────────────── */

export type QuietBeaconProps = {
  /** true while a cycle is in flight — the beacon tightens and speeds up. */
  active?: boolean;
};

/**
 * The signature mark of the product: a slow sonar sweep. It is the visual
 * argument for the whole idea — something is watching, on a five-second breath,
 * and it is not asking you for anything.
 */
export function QuietBeacon(props: QuietBeaconProps): JSX.Element {
  const { active = false } = props;
  return (
    <div className={`sq-beacon${active ? " sq-beacon--active" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 120 120" width="100%" height="100%">
        <defs>
          <radialGradient id="sq-beacon-core">
            <stop offset="0%" stopColor="var(--sq-brand)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--sq-brand)" stopOpacity="0.35" />
          </radialGradient>
        </defs>
        <g className="sq-beacon__rings" stroke="var(--sq-brand)" fill="none" strokeWidth="1">
          <circle className="sq-beacon__ring sq-beacon__ring--1" cx="60" cy="60" r="38" />
          <circle className="sq-beacon__ring sq-beacon__ring--2" cx="60" cy="60" r="38" />
          <circle className="sq-beacon__ring sq-beacon__ring--3" cx="60" cy="60" r="38" />
        </g>
        <circle className="sq-beacon__halo" cx="60" cy="60" r="17" fill="var(--sq-brand)" opacity="0.16" />
        <circle className="sq-beacon__core" cx="60" cy="60" r="8" fill="url(#sq-beacon-core)" />
      </svg>
    </div>
  );
}

/* ───────────────────────────────  Orbit  ─────────────────────────────────── */

export type OrbitProps = { size?: number; tone?: "brand" | "ember" | "current" };

/**
 * The working mark: a dashed arc orbiting a still centre. Used at 18px inside
 * buttons and at 56px inside the WorkingWidget, so "busy" looks the same
 * everywhere at two scales.
 */
export function Orbit(props: OrbitProps): JSX.Element {
  const { size = 20, tone = "current" } = props;
  const stroke =
    tone === "brand" ? "var(--sq-brand)" : tone === "ember" ? "var(--sq-ember)" : "currentColor";
  return (
    <svg
      className="sq-orbit"
      viewBox="0 0 44 44"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      data-sq-motion="working"
    >
      <circle cx="22" cy="22" r="18" stroke={stroke} strokeOpacity="0.18" strokeWidth="3" />
      <circle
        className="sq-orbit__arc"
        cx="22"
        cy="22"
        r="18"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="34 79"
      />
      <circle className="sq-orbit__hub" cx="22" cy="22" r="3.2" fill={stroke} fillOpacity="0.5" />
    </svg>
  );
}

/* ────────────────────────────  Working widget  ───────────────────────────── */

export type WorkingWidgetProps = {
  /** Headline: the operation the host started, in their words. */
  title: string;
  /** The live sub-step, when the stream knows one. Falls back to the reel. */
  detail?: string | null;
  /**
   * Rotating one-line explanations of what is happening under the hood. One is
   * shown at a time, 2.6s each, so a host watching a 10s cycle is told three
   * true things instead of staring at a spinner.
   */
  reel?: string[];
  tone?: "brand" | "ember";
  /** "panel" for the monitor, "inline" for a decision card. */
  variant?: "panel" | "inline";
};

const DEFAULT_REEL = ["Working…"];

export function WorkingWidget(props: WorkingWidgetProps): JSX.Element {
  const { title, detail = null, reel = DEFAULT_REEL, tone = "brand", variant = "panel" } = props;
  const lines = reel.length > 0 ? reel : DEFAULT_REEL;
  const [i, setI] = useState(0);

  useEffect(() => {
    if (lines.length < 2) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % lines.length), 2600);
    return () => clearInterval(id);
  }, [lines.length]);

  const line = detail ?? lines[i % lines.length] ?? "";

  return (
    <div
      className={`sq-working sq-working--${variant} sq-working--${tone}`}
      role="status"
      aria-live="polite"
    >
      <div className="sq-working__mark">
        <Orbit size={variant === "panel" ? 44 : 20} tone={tone} />
      </div>
      <div className="sq-working__copy">
        <p className="sq-working__title">{title}</p>
        {/* keyed so each new line re-runs the entrance — the text moves too */}
        <p className="sq-working__detail" key={line}>
          {line}
        </p>
      </div>
      <div className="sq-busy-bar" aria-hidden="true">
        <span className="sq-busy-bar__fill" data-sq-motion="working" />
      </div>
    </div>
  );
}

/* ────────────────────────────  Exposure meter  ───────────────────────────── */

export type ExposureMeterProps = {
  /** The modelled figure, in euros. */
  value: number;
  /** The largest figure on screen, so the arcs are comparable card to card. */
  max: number;
  tone?: "refund" | "exception" | "risk";
};

/**
 * A 270° gauge. It exists because "€306.00" alone gives a host no sense of
 * whether this is the big one on the page; the arc does that at a glance while
 * the number stays the source of truth. The arc draws in on mount (sq-draw).
 */
export function ExposureMeter(props: ExposureMeterProps): JSX.Element {
  const { value, max, tone = "refund" } = props;
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0.04, Math.min(1, value / safeMax));
  const r = 34;
  const arc = 2 * Math.PI * r * 0.75; // 270° of the circle
  const filled = arc * ratio;

  return (
    <div className={`sq-meter sq-meter--${tone}`}>
      <svg viewBox="0 0 88 88" width="88" height="88" fill="none" aria-hidden="true">
        <g transform="rotate(135 44 44)">
          <circle
            cx="44"
            cy="44"
            r={r}
            stroke="currentColor"
            strokeOpacity="0.16"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${arc} 999`}
          />
          <circle
            className="sq-meter__arc"
            cx="44"
            cy="44"
            r={r}
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${filled} 999`}
            style={{ ["--sq-draw-length" as string]: String(filled) }}
          />
        </g>
      </svg>
      <div className="sq-meter__value">
        <span className="sq-meter__currency">€</span>
        <span className="sq-meter__number">{value.toFixed(0)}</span>
      </div>
    </div>
  );
}

/* ──────────────────────────────  Stat tile  ──────────────────────────────── */

export type StatProps = {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "brand" | "ember";
};

export function Stat(props: StatProps): JSX.Element {
  const { label, value, hint, tone = "neutral" } = props;
  return (
    <div className={`sq-stat sq-stat--${tone}`} title={hint}>
      <span className="sq-stat__value">{value}</span>
      <span className="sq-stat__label">{label}</span>
    </div>
  );
}

/* ────────────────────────────  Quiet-work bar  ───────────────────────────── */

export type QuietWorkBarProps = { affected: number; scanned: number };

/**
 * The "handled quietly" proof: one bar where the filled part is what needed the
 * host and the rest is what did not. This is the product's core claim rendered
 * as a shape, and it is the single most persuasive element on the quiet screen.
 */
export function QuietWorkBar(props: QuietWorkBarProps): JSX.Element {
  const { affected, scanned } = props;
  const total = scanned > 0 ? scanned : 1;
  const pct = Math.min(100, Math.round((affected / total) * 100));
  return (
    <div className="sq-quietbar">
      <div
        className="sq-quietbar__track"
        role="img"
        aria-label={`${affected} of ${scanned} bookings needed work; the rest were handled quietly`}
      >
        <span className="sq-quietbar__fill" style={{ ["--sq-pct" as string]: `${pct}%` }} />
      </div>
      <p className="sq-quietbar__legend">
        <span className="sq-quietbar__key sq-quietbar__key--worked" />
        {affected} worked
        <span className="sq-quietbar__key sq-quietbar__key--quiet" />
        {Math.max(0, scanned - affected)} handled quietly
      </p>
    </div>
  );
}

/* ──────────────────────────────  Skeletons  ──────────────────────────────── */

/** Shown for the first poll, so the page never opens as an empty rectangle. */
export function SkeletonLines(props: { lines?: number }): JSX.Element {
  const n = props.lines ?? 3;
  return (
    <div className="sq-skeleton" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="sq-shimmer sq-skeleton__line" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

/* ────────────────────────────────  Icons  ────────────────────────────────── */

export type IconProps = { size?: number };

const ICON_BASE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconCheck({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} {...ICON_BASE} aria-hidden="true">
      <path d="M3.8 10.4 L8 14.4 L16.2 5.6" />
    </svg>
  );
}

export function IconPencil({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} {...ICON_BASE} aria-hidden="true">
      <path d="M13.3 3.4a1.7 1.7 0 0 1 2.4 2.4L7.1 14.4l-3.2.8.8-3.2z" />
      <path d="M12 4.7 14.6 7.3" />
    </svg>
  );
}

export function IconPlay({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} {...ICON_BASE} aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.4 7.2 13 10l-4.6 2.8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconShield({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} {...ICON_BASE} aria-hidden="true">
      <path d="M10 2.6 16 4.8v4.6c0 3.4-2.4 6.4-6 7.9-3.6-1.5-6-4.5-6-7.9V4.8z" />
      <path d="M7.4 10 9.4 12 12.8 8.2" />
    </svg>
  );
}

export function IconLedger({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} {...ICON_BASE} aria-hidden="true">
      <path d="M4.6 2.8h9.2a1.6 1.6 0 0 1 1.6 1.6v11.2a1.6 1.6 0 0 1-1.6 1.6H4.6z" />
      <path d="M4.6 2.8a1.6 1.6 0 0 0-1.6 1.6v11.2a1.6 1.6 0 0 0 1.6 1.6" />
      <path d="M7 6.6h5.4M7 9.6h5.4M7 12.6h3.2" />
    </svg>
  );
}
