// Requirement IDs: SCRIPT-02, SCRIPT-RES-02, DECKGEN-REU-01, XCUT-08 — DP-D2a §4.2/§6.5.
//
// Visual-cue vocabulary + validation. Screens come from TWO single sources:
// contracts/ui-screen-catalog.json (the closed enum platform/ui ships) and the
// included components of assembly.manifest.json. A `Visual:` cue naming any
// other id is rewritten to a TODO suggestion by enforceVisuals (post-generation
// pass) — an invented screen can never reach the final take (SCRIPT-RES-02).
//
// Guards implemented here (§6.5):
//   1. allowedScreens() feeds the prompt constraint ("only use these ids").
//   2. validateVisualCue()/enforceVisuals() rewrite invalid cues post-hoc + warn.
//   3. uiIncluded() is the manifest-change guard: with platform/ui excluded,
//      every cue degrades to the no-UI TODO wording even though the catalog
//      file itself still lists screens.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
export const UI_SCREEN_CATALOG_PATH = join(REPO_ROOT, "contracts", "ui-screen-catalog.json");

/** Minimal structural views ($ref shapes; never re-defined contracts). */
export interface UiScreen {
  id: string;
  title?: string;
  description?: string;
}

export interface UiScreenCatalog {
  version?: string;
  screens: UiScreen[];
}

export interface ManifestComponent {
  id: string;
  included: boolean;
}

export interface AssemblyManifestView {
  components: ManifestComponent[];
}

//#region catalog loading

let catalogCache: UiScreenCatalog | null = null;

/** contracts/ui-screen-catalog.json — closed enum of shipped screen ids. */
export function loadUiScreenCatalog(): UiScreenCatalog {
  return (catalogCache ??= JSON.parse(readFileSync(UI_SCREEN_CATALOG_PATH, "utf8")) as UiScreenCatalog);
}

/**
 * catalogUiScreensFor(componentId) — which catalog screens an INCLUDED
 * component contributes to the live-demo vocabulary. `platform` (and its
 * expanded sub-component `platform/ui`) contribute the whole catalog; no other
 * chassis component ships UI screens. Domain-free: ids only, from the catalog.
 */
export function catalogUiScreensFor(componentId: string, catalog: UiScreenCatalog): string[] {
  if (componentId === "platform" || componentId === "platform/ui") {
    return catalog.screens.map((s) => s.id);
  }
  return [];
}

//#endregion

//#region §6.5 guard 3 — manifest/UI presence

/**
 * uiIncluded(manifest) — true when the manifest includes platform (expanded to
 * platform/ui) or platform/ui itself. False → deriveVisualCues degrades EVERY
 * cue to the no-UI TODO wording regardless of catalog contents (§4.2).
 */
export function uiIncluded(manifest: AssemblyManifestView | null): boolean {
  if (!manifest || !Array.isArray(manifest.components)) return false;
  return manifest.components.some((c) => c.included && (c.id === "platform" || c.id === "platform/ui"));
}

/**
 * allowedScreens(manifest, catalog) — §6.5 guard 1 vocabulary:
 * catalog screens ∪ manifest-included component screens (joined for the
 * prompt's mandated line and TODO suggestions).
 */
export function allowedScreens(manifest: AssemblyManifestView | null, catalog: UiScreenCatalog): string[] {
  const set = new Set<string>();
  for (const s of catalog.screens) set.add(s.id);
  if (manifest && Array.isArray(manifest.components)) {
    for (const c of manifest.components) {
      if (!c.included) continue;
      for (const id of catalogUiScreensFor(c.id, catalog)) set.add(id);
    }
  }
  return [...set];
}

/** The §4.2 no-UI degradation literal used for every cue when UI is absent. */
export function noUiTodoCue(): string {
  return "Visual: TODO — no UI component selected in manifest — add platform/ui or point to live demo URL manually.";
}

/** TODO suggestion listing the allowed vocabulary (§4.2 rewritten form). */
export function todoCueSuggestion(manifest: AssemblyManifestView | null, catalog: UiScreenCatalog): string {
  const allowed = allowedScreens(manifest, catalog);
  return `TODO — select from manifest UI screens: ${allowed.join(", ")}`;
}

//#endregion

//#region §4.2 validation + §6.5 guard 2 post-generation pass

export interface VisualCueVerdict {
  valid: boolean;
  /** Rewritten cue body when invalid (without the "Visual: " prefix). */
  suggested?: string;
  reason?: string;
}

/**
 * validateVisualCue(cue, manifest, catalog) — per §4.2 reference code: extract
 * the screen id after `Visual:`, accept it when present in the allowed
 * vocabulary, else return the TODO suggestion. The caller additionally rejects
 * title-card/static cues on live rows (see enforceVisuals).
 */
export function validateVisualCue(
  cue: string,
  manifest: AssemblyManifestView | null,
  catalog: UiScreenCatalog,
): VisualCueVerdict {
  const screenId = cue.match(/Visual:\s*([\w-]+)/)?.[1];
  if (!screenId) return { valid: false };
  // Already-degraded TODO cues (incl. the §4.2 no-UI wording) are valid by
  // construction — never rewrite a TODO into another TODO.
  if (screenId.toUpperCase() === "TODO") return { valid: true };
  const allowed = new Set([
    ...catalog.screens.map((s) => s.id),
    ...(manifest && Array.isArray(manifest.components)
      ? manifest.components.filter((c) => c.included).flatMap((c) => catalogUiScreensFor(c.id, catalog))
      : []),
  ]);
  // With platform/ui excluded the vocabulary must not silently include catalog
  // ids nothing can show (§6.5 guard 3) — degrade instead of validating.
  if (!uiIncluded(manifest)) {
    return { valid: false, suggested: todoCueSuggestion(manifest, catalog), reason: "no-ui-component" };
  }
  if (allowed.has(screenId)) return { valid: true };
  return {
    valid: false,
    suggested: todoCueSuggestion(manifest, catalog),
    reason: `screen ${screenId} not in manifest/library`,
  };
}

export interface EnforceResult {
  markdown: string;
  /** Number of cues rewritten (each one also warned by the caller's sink). */
  rewrites: string[];
}

/** Live-row marker that must survive every rewrite (SCRIPT-03). */
export const LIVE_DEMO_LABEL = "\u25B6 LIVE DEMO \u2014 moving capture";

/**
 * enforceVisuals(markdown, manifest, catalog, liveTitles, warn) — §6.5 guard 2
 * post-generation pass over every table row / line carrying `Visual:`:
 * - an id outside the allowed vocabulary → rewritten to the TODO suggestion +
 *   `warn: script visual <id> not in manifest/library — rewritten to TODO`;
 * - a live section whose cue says "title card"/"static" → rewritten to the
 *   `▶ LIVE DEMO — moving capture` form (SCRIPT-03 prohibition);
 * - everything else passes through untouched. Never throws; script always
 *   produced (GOV-RES-01).
 */
export function enforceVisuals(
  markdown: string,
  manifest: AssemblyManifestView | null,
  catalog: UiScreenCatalog,
  isLiveRow: (row: string) => boolean,
  warn: (message: string) => void = (m) => console.warn(m),
): EnforceResult {
  const rewrites: string[] = [];
  const lines = markdown.split(/\r?\n/);
  const out = lines.map((line) => {
    if (!/Visual:/.test(line)) return line;
    const live = isLiveRow(line);

    // SCRIPT-03: static/title-card cues are forbidden on live rows.
    if (live && /title card|static/i.test(line) && !line.includes(LIVE_DEMO_LABEL)) {
      rewrites.push("live row carried a static/title-card cue — replaced with ▶ LIVE DEMO label");
      warn("warn: live section visual cue refused static/title card — rewritten to ▶ LIVE DEMO");
      return line.replace(/Visual:.*/, `**${LIVE_DEMO_LABEL}** — Visual: ${todoCueSuggestion(manifest, catalog)}`);
    }

    const verdict = validateVisualCue(line, manifest, catalog);
    if (verdict.valid) return line;
    const inventedId = line.match(/Visual:\s*([\w-]+)/)?.[1] ?? "(none)";
    rewrites.push(`${inventedId} → ${verdict.suggested ?? "TODO"}`);
    if (verdict.reason === "no-ui-component") {
      warn("warn: no UI component selected in manifest — visual cues degraded to TODO");
    } else {
      warn(`warn: script visual ${inventedId} not in manifest/library — rewritten to TODO`);
    }
    return line.replace(/Visual:.*/, `Visual: ${verdict.suggested ?? "TODO"}`);
  });
  return { markdown: out.join("\n"), rewrites };
}

//#endregion
