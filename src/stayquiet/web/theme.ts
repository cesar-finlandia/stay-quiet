// StayQuiet UI — colour-mode controller (light / dark / follow the system).
//
// Why this and not src/platform/ui/theme.ts: that module owns the chassis's
// three *visual identities* (minimal / editorial / operator) and writes
// data-theme. StayQuiet ships exactly one identity in two colour modes, which
// is a different axis, so it writes its own attribute — data-sq-mode — and
// leaves data-theme alone. src/stayquiet/web/design/tokens.css keys off it.
//
// The applied mode is always concrete ("light" or "dark"); the *preference*
// may additionally be "system", in which case the OS decides and keeps
// deciding while the tab is open.

export type ColorMode = "light" | "dark";
export type ColorModePreference = ColorMode | "system";

const STORAGE_KEY = "stayquiet:color-mode";
const ATTRIBUTE = "data-sq-mode";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Same logic as the inline boot script in index.html — keep them in step. */
export function readPreference(): ColorModePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* private mode, or no storage — fall through to the system default */
  }
  return "system";
}

function systemMode(): ColorMode {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The mode a preference resolves to right now. */
export function resolveMode(pref: ColorModePreference): ColorMode {
  return pref === "system" ? systemMode() : pref;
}

function apply(mode: ColorMode): void {
  try {
    document.documentElement.setAttribute(ATTRIBUTE, mode);
    // Suppress the cross-fade for the very first paint only; after that a
    // deliberate 260ms fade makes the toggle feel like a dimmer, not a flash.
    document.documentElement.dataset["sqModeReady"] = "true";
  } catch {
    /* no DOM (tests) — nothing to paint */
  }
}

/**
 * Persist a preference and paint it. Passing "system" removes the stored
 * override so the OS takes over again.
 */
export function setPreference(pref: ColorModePreference): ColorMode {
  try {
    if (pref === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage unavailable — the mode still applies for this session */
  }
  const mode = resolveMode(pref);
  apply(mode);
  return mode;
}

/**
 * Called once from main.tsx. The attribute is already set by the boot script
 * in index.html (that is what prevents a light flash before a dark paint);
 * this re-applies it from the same source of truth and subscribes to OS
 * changes so a host who leaves the tab open overnight follows their machine.
 *
 * Returns an unsubscribe function.
 */
export function initColorMode(onChange?: (mode: ColorMode) => void): () => void {
  apply(resolveMode(readPreference()));
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(DARK_QUERY);
  } catch {
    return () => undefined;
  }
  const listener = (): void => {
    if (readPreference() !== "system") return; // an explicit choice outranks the OS
    const mode = systemMode();
    apply(mode);
    onChange?.(mode);
  };
  try {
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  } catch {
    return () => undefined;
  }
}
