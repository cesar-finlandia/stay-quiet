// StayQuiet UI — the "How this demo works" explainer: a "?" button that opens
// a small popover narrating what a background cycle does and what pressing
// "Run a cycle now" triggers. Truthful by design: the data is synthetic and
// static, so the copy promises a re-run over that data — never live inbound
// messages that do not exist.
import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";

export function HowItWorks(): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open ]);

  return (
    <span className="sq-how" ref={rootRef}>
      <button
        type="button"
        className="sq-how__btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="How this demo works"
        title="How this demo works"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open ? (
        <div className="sq-how__panel" id={panelId} role="dialog" aria-label="How this demo works">
          <p className="sq-how__lede">
            Everything here is synthetic demo data — bookings, guest messages and policy
            pages. Nothing arrives live; instead, each background cycle re-checks that
            data end to end.
          </p>
          <ol className="sq-how__steps">
            <li>Reads the current policy page and diffs it against the previous capture.</li>
            <li>Finds the bookings those changes touch and reads their messages.</li>
            <li>
              Drafts a reply per booking — with the Bedrock AI when credentials are set,
              otherwise from the recorded cache — plus a turnover checklist.
            </li>
            <li>
              Asks you only about money, exceptions and review risks, and files the rest
              quietly with an audit entry.
            </li>
          </ol>
          <p className="sq-how__cta">
            Press <strong>Run a cycle now</strong> below and watch the step list light up,
            the latest draft appear, and any new decisions arrive. The agent also runs on
            its own every few minutes.
          </p>
        </div>
      ) : null}
    </span>
  );
}
