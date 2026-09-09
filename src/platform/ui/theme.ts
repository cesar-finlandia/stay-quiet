// Requirement IDs: UI-03, UI-04, UI-AC-02, GOV-RES-02 | DP-B §6.3, §6.4
// Theme mechanism: a single setTheme() call flips the data-theme attribute on
// <html>; the token overrides in src/platform/ui/themes/*.css do the rest —
// no component logic or JSX edits (UI-03). Unknown THEME values fall back to
// "minimal" with a console.warn at bootstrap (GOV-RES-02 safe default).
export type ThemeId = "minimal" | "editorial" | "operator";

export interface ThemeDefinition {
  id: ThemeId;
  /** Human-facing name for docs/demos; not user-facing copy (UI-REU-01). */
  label: string;
  stylesheet: `./themes/${ThemeId}.css`;
}

export const themes: Record<ThemeId, ThemeDefinition> = {
  minimal: { id: "minimal", label: "Minimal", stylesheet: "./themes/minimal.css" },
  editorial: { id: "editorial", label: "Editorial", stylesheet: "./themes/editorial.css" },
  operator: { id: "operator", label: "Operator", stylesheet: "./themes/operator.css" },
};

const THEME_IDS: readonly ThemeId[] = ["minimal", "editorial", "operator"];

let currentThemeId: ThemeId = "minimal";

function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value);
}

/** Single config change swaps visual identity (UI-AC-02). */
export function setTheme(id: ThemeId): void {
  currentThemeId = id;
  // Structurally-typed document lookup: keeps this module compilable under
  // DOM-less Node programs (tsconfig.test.json) while acting in browsers.
  const doc = (globalThis as { document?: { documentElement: { setAttribute(name: string, value: string): void } } })
    .document;
  if (doc) {
    doc.documentElement.setAttribute("data-theme", id);
  }
}

/**
 * Bootstrap helper (GOV-RES-02): validate an untyped THEME config value
 * (env.theme / config/theme.json) — unknown values warn and fall back to
 * "minimal". Returns the applied theme.
 */
export function resolveTheme(value: string | undefined | null): ThemeId {
  if (value === undefined || value === null || value === "") return "minimal";
  if (isThemeId(value)) {
    setTheme(value);
    return value;
  }
  console.warn(`[ui] unknown THEME "${value}" — falling back to "minimal" (GOV-RES-02)`);
  setTheme("minimal");
  return "minimal";
}

export function currentTheme(): ThemeId {
  return currentThemeId;
}
