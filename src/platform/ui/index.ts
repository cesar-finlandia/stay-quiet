// Requirement IDs: UI-01, UI-02, UI-03, UI-04, UI-05, UI-REU-01, UI-REU-02, UI-RES-01, UI-RES-02 | DP-B §6.1, §6.3
// Curated public surface of the platform UI library. Consumers import the
// three envelope-only components (UI-01) exclusively from here; each works
// standalone (UI-02) against any backend emitting valid EventEnvelope[] (UI-05,
// UI-REU-02). Theming (UI-03/UI-04): setTheme/currentTheme/resolveTheme flip a
// single data-theme attribute — token overrides in themes/*.css do the rest.
export { StepStatusIndicator } from "./StepStatusIndicator.js";
export type { StepStatusIndicatorProps } from "./StepStatusIndicator.js";
export { StreamingTextRenderer } from "./StreamingTextRenderer.js";
export type { StreamingTextRendererProps } from "./StreamingTextRenderer.js";
export { CitationDisplay } from "./CitationDisplay.js";
export type { Citation, CitationDisplayProps } from "./CitationDisplay.js";
export { degradedResultOf, isDegradedEnvelope } from "./isDegraded.js";

// --- Theming (UI-03/UI-04): single-config identity switch via data-theme. ---
export { currentTheme, resolveTheme, setTheme, themes } from "./theme.js";
export type { ThemeDefinition, ThemeId } from "./theme.js";
