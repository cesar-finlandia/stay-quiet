// StayQuiet UI — the global colour-mode toggle.
//
// A single control in the header, always in the same place, with a visible
// label. It cycles Light → Dark → System and back; "System" is offered because
// a host who runs their phone on an evening schedule expects the app to follow
// it. The icon is one SVG that morphs: the sun's rays retract and a shadow disc
// slides across the core to make the moon, so the two states read as the same
// object at two times of day rather than as two unrelated glyphs.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { ColorMode, ColorModePreference } from "./theme.js";
import { initColorMode, readPreference, resolveMode, setPreference } from "./theme.js";

const ORDER: ColorModePreference[] = ["light", "dark", "system"];

const LABEL: Record<ColorModePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const HINT: Record<ColorModePreference, string> = {
  light: "Daylight Linen — switch to Night Desk",
  dark: "Night Desk — follow my system setting",
  system: "Following your system — switch to Daylight Linen",
};

export function ThemeToggle(): JSX.Element {
  const [pref, setPref] = useState<ColorModePreference>(() => readPreference());
  const [mode, setMode] = useState<ColorMode>(() => resolveMode(readPreference()));

  useEffect(() => initColorMode((m) => setMode(m)), []);

  const cycle = useCallback(() => {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] ?? "light";
    setPref(next);
    setMode(setPreference(next));
  }, [pref]);

  return (
    <button
      type="button"
      className="sq-theme-toggle"
      onClick={cycle}
      aria-label={`Colour mode: ${LABEL[pref]}. ${HINT[pref]}`}
      title={HINT[pref]}
      data-mode={mode}
      data-pref={pref}
    >
      <span className="sq-theme-toggle__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          {/* Rays — retract into the core when the moon takes over. */}
          <g className="sq-theme-toggle__rays" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <line x1="12" y1="1.6" x2="12" y2="4.1" />
            <line x1="12" y1="19.9" x2="12" y2="22.4" />
            <line x1="1.6" y1="12" x2="4.1" y2="12" />
            <line x1="19.9" y1="12" x2="22.4" y2="12" />
            <line x1="4.6" y1="4.6" x2="6.4" y2="6.4" />
            <line x1="17.6" y1="17.6" x2="19.4" y2="19.4" />
            <line x1="4.6" y1="19.4" x2="6.4" y2="17.6" />
            <line x1="17.6" y1="6.4" x2="19.4" y2="4.6" />
          </g>
          <mask id="sq-toggle-mask">
            <rect x="0" y="0" width="24" height="24" fill="white" />
            {/* The shadow disc: parked off-glyph in light, eclipsing in dark. */}
            <circle className="sq-theme-toggle__shadow" cx="24" cy="4" r="8" fill="black" />
          </mask>
          <circle
            className="sq-theme-toggle__core"
            cx="12"
            cy="12"
            r="5.6"
            fill="currentColor"
            mask="url(#sq-toggle-mask)"
          />
        </svg>
      </span>
      <span className="sq-theme-toggle__label">{LABEL[pref]}</span>
    </button>
  );
}
