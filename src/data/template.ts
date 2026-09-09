// Requirement IDs: DATA-REU-01, XCUT-08
// src/data/template.ts — tiny Mustache-style renderer (DP-H §3.4 "Rendering").
// Exact {{key}} substitution only — no external dependency, no logic tags.
// Internal module: NOT re-exported from src/data/index.ts (DP-H §8.4 deep-import rule).

/** Replace every {{key}} occurrence with vars[key]; unknown keys render as empty string. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match: string, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
    return value ?? "";
  });
}
