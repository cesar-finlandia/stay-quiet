// Requirement IDs: SCRIPT-01..05, SCRIPT-RES-01, SCRIPT-RES-02, XCUT-08 —
// DP-D2a §8.2 module surface. Re-exports only; no logic here.

export { blankTemplate, composeScriptMarkdown, deriveVisualCue, fallbackSpoken, generateScript, parseSpokenDraft, renderScriptPrompt, timingSummaryFor, writeFileDiffAware, reconcileGeneratedAt, SCRIPT_GEN_CONFIG, SCRIPT_GENERATOR_ROLE, DEFAULT_TIMING_PATH, SCRIPT_PROMPT_PATH } from "./generate.js";
export type { GenerateScriptInput, ScriptLlmTransport, ScriptResult, ScriptSectionResult } from "./generate.js";
export { computeWindows, formatMMSS, loadTiming, parseTimingYaml, sumSectionMinutes, validateTiming, WINDOW_SEPARATOR, TimingValidationError } from "./timing.js";
export type { TimingConfig, TimingSection, TimingWindow } from "./timing.js";
export { extractProfileMaxMinutes, loadEventProfile, resolveTotalMinutes, FALLBACK_TOTAL_MINUTES } from "./defaultTotal.js";
export { allowedScreens, catalogUiScreensFor, enforceVisuals, loadUiScreenCatalog, noUiTodoCue, todoCueSuggestion, uiIncluded, validateVisualCue, LIVE_DEMO_LABEL, UI_SCREEN_CATALOG_PATH } from "./validateVisuals.js";
export type { AssemblyManifestView, ManifestComponent, UiScreen, UiScreenCatalog, VisualCueVerdict } from "./validateVisuals.js";
export { auditSpokenBusinessValue, extractBusinessValue, extractHeadingBody, firstSentence, isSilent, emptyAllowList, BV_AUDIT_TODO, BV_SILENT_TODO } from "./extractBusinessValue.js";
export type { AllowList, AuditResult } from "./extractBusinessValue.js";
