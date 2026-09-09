// Requirement IDs: SCRIPT-01..05, SCRIPT-RES-01, SCRIPT-RES-02, RES-01, RES-06,
// GOV-RES-01, GOV-RES-04, XCUT-08 — DP-D2a §4.2–§4.5/§6.4/§6.5/§9.3–§9.5.
//
// script generate — pure function (plan bytes, manifest, timing config) →
// script.md. ONE RES-01-wrapped LLM call phrases spoken rhetoric for the WHOLE
// script (timeout 20000ms, retries 1, exponential backoff base 400/max 3000 +
// jitter, fallback_chain ["none"] — §6.1); visuals are derived WITHOUT an LLM
// from manifest + contracts/ui-screen-catalog.json (SCRIPT-02), Business Value
// figures are extracted mechanically (SCRIPT-04) and audited so a stray number
// is rewritten to the TODO literal, and the live section carries the mandated
// `▶ LIVE DEMO — moving capture` cue (SCRIPT-03, U+25B6).
//
// Failure semantics (SCRIPT-RES-01): any DegradedResult/throw collapses to
// blankTemplate(timing, manifest) — accurate mm:ss headers + valid TODO visual
// cues + preserved ▶ LIVE DEMO row — never an empty file, atomic tmp+rename,
// diff-before-write idempotence (SCRIPT-05 / §4.5).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDegradedResult, withResilience } from "../../resilience/index.js";
import { getModelForRole } from "../deckgen/phrase.js";
import { resolveTotalMinutes, extractProfileMaxMinutes, type EventProfile } from "./defaultTotal.js";
import type { WarnFn } from "./defaultTotal.js";
import {
  auditSpokenBusinessValue,
  BV_AUDIT_TODO,
  BV_SILENT_TODO,
  extractBusinessValue,
  extractHeadingBody,
  firstSentence,
  isSilent,
  type AllowList,
} from "./extractBusinessValue.js";
import {
  allowedScreens,
  enforceVisuals,
  LIVE_DEMO_LABEL,
  loadUiScreenCatalog,
  noUiTodoCue,
  todoCueSuggestion,
  uiIncluded,
  type AssemblyManifestView,
  type UiScreenCatalog,
} from "./validateVisuals.js";
import { computeWindows, formatMMSS, parseTimingYaml, validateTiming, type TimingConfig, type TimingWindow } from "./timing.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SCRIPT_PROMPT_PATH = join(SCRIPT_DIR, "templates", "script.prompt.md");
/** Module-default timing (checked-in CONFIG, not hardcoded minutes). */
export const DEFAULT_TIMING_PATH = join(SCRIPT_DIR, "templates", "script-timing.example.yaml");

/** Shared-file role key (§7): script_generator → analyst-balanced profile. */
export const SCRIPT_GENERATOR_ROLE = "script_generator";

/** §6.1 wrapper defaults for the SCRIPT spoken-phrasing call. */
export const SCRIPT_GEN_CONFIG = {
  timeout_ms: 20000,
  retries: 1,
  backoff: { policy: "exponential" as const, base_ms: 400, factor: 2, max_ms: 3000, jitter: true },
  fallback_chain: { order: ["none" as const] },
} satisfies import("../../resilience/index.js").ResilienceConfig;

/** Minimal transport contract: prompt in, completion text out (tests mock it). */
export type ScriptLlmTransport = (prompt: string) => string | Promise<string>;

//#region result types

export interface ScriptSectionResult {
  id: string;
  title: string;
  minutes: number;
  start: string;
  end: string;
  live: boolean;
  /** Final spoken-cell text (may be a `> **TODO:** …` literal). */
  spoken: string;
  /** Final visual-cell text (always valid against manifest + catalog). */
  visual: string;
}

export interface ScriptResult {
  markdown: string;
  total_minutes: number;
  /** Which precedence branch won: timing.yaml | event_profile seed | fallback 3. */
  timing_source: string;
  live_section: string | null;
  sections: ScriptSectionResult[];
  /** Present ONLY on the SCRIPT-RES-01 degraded path. */
  fallback?: "blank_template";
  warnings: string[];
  /** True when bytes were (re)written this run; false on diff-before-write skip. */
  written: boolean;
}

export interface GenerateScriptInput {
  /** winning_project_plan.md bytes ("" tolerated → TODO spoken blocks). */
  plan: string;
  /** Parsed assembly.manifest.json, or null when absent/invalid. */
  manifest: AssemblyManifestView | null;
  /** Validated timing config, or null → module-default timing file. */
  timing: TimingConfig | null;
  /** Optional event_profile.json view (PROFILE-05 advisory total seed). */
  profile?: EventProfile | null;
  /** Output path; omitted → compose only (tests/dry-runs). */
  writeTo?: string;
  /** Provider callable; omitted/unresolved role → degraded → blank template. */
  transport?: ScriptLlmTransport;
  warn?: WarnFn;
}

//#endregion

//#region prompt rendering + response parsing

let cachedPromptTemplate: string | null = null;

function loadPromptTemplate(): string {
  if (cachedPromptTemplate === null) cachedPromptTemplate = readFileSync(SCRIPT_PROMPT_PATH, "utf8");
  return cachedPromptTemplate;
}

/**
 * Render the generic prompt (GOV-REU-02): only planExcerpt/timingSummary/
 * allowedScreens injected. Carries the two mandated lines — the allowed-screen
 * constraint (§6.5 guard 1) and the SCRIPT-04 excerpt discipline sentence.
 */
export function renderScriptPrompt(planExcerpt: string, timingSummary: string, allowed: string[]): string {
  return loadPromptTemplate()
    .replace("{{planExcerpt}}", planExcerpt.trim())
    .replace("{{timingSummary}}", timingSummary.trim())
    .replace("{{allowedScreens}}", allowed.join(", "));
}

/** One-line-per-section summary fed to the prompt (ids + mm:ss lengths). */
export function timingSummaryFor(windows: TimingWindow[]): string {
  return windows.map((w) => `- ${w.id} (${w.title}): ${w.window} [${w.minutes} min]${w.live ? " [LIVE]" : ""}`).join("\n");
}

/**
 * Parse the completion: lines of `<section-id>: <spoken paragraph>`. Lenient —
 * ids not matching any configured section are ignored; missing ids fall back
 * to the mechanical extractor downstream.
 */
export function parseSpokenDraft(raw: string, windows: TimingWindow[]): Record<string, string> {
  const ids = new Set(windows.map((w) => w.id));
  const out: Record<string, string> = {};
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const m = /^\s*([a-z0-9][a-z0-9-]*)\s*:\s*(.+?)\s*$/i.exec(rawLine);
    if (!m) continue;
    const id = (m[1] ?? "").toLowerCase();
    const text = (m[2] ?? "").trim();
    if (!ids.has(id) || text === "") continue;
    out[id] ??= text;
  }
  return out;
}

//#endregion

//#region mechanical spoken fallbacks + Business Value audit (SCRIPT-04)

/** Generic TODO for sections with no mechanical source (never blank). */
function genericTodoSpoken(win: TimingWindow): string {
  return `> **TODO:** Spoken text — fill from winning_project_plan.md for "${win.title}" manually.`;
}

/**
 * Mechanical per-section spoken text when the LLM draft has no line for the
 * section (or no LLM ran but the caller chose extractive mode). Extractive
 * only — verbatim plan sentences or allow-list figures, never invention.
 */
export function fallbackSpoken(win: TimingWindow, planText: string, allow: AllowList): string {
  if (win.id.includes("business") || win.id.includes("value")) {
    if (isSilent(allow)) return BV_SILENT_TODO;
    // Only tam_figure/revenue_model/why_ai feed the mechanical sentence:
    // specific_user/why_now often carry digits outside the §4.4 audit
    // vocabulary (tam_figure/revenue_model), which would self-trigger the
    // never-fabrication rewrite.
    const parts: string[] = [];
    if (allow.tam_figure) parts.push(`serves ${allow.tam_figure} per winning_project_plan.md`);
    if (allow.revenue_model) parts.push(`monetized via ${allow.revenue_model}`);
    if (allow.why_ai) parts.push(`why AI: ${allow.why_ai}`);
    const sentence = parts.join(" — ");
    return sentence === "" ? BV_SILENT_TODO : `${sentence}.`;
  }
  if (win.live) {
    return "Walk through the assembled flow live — moving capture, never a static title card.";
  }
  if (win.id.includes("problem")) {
    const s = firstSentence(extractHeadingBody(planText, "Problem Framing"));
    return s ?? genericTodoSpoken(win);
  }
  if (win.id.includes("team") || win.id.includes("roadmap")) {
    return "> **TODO:** Team & ask — no roster in winning_project_plan.md — describe members, roles, and ask manually.";
  }
  return genericTodoSpoken(win);
}

/**
 * Apply the §4.4 never-fabrication audit to the Business Value section's
 * spoken paragraph; on a stray numeric token the whole cell is rewritten to
 * BV_AUDIT_TODO and `invented claim <token>` is warned (§4.4).
 */
function auditBusinessValueCell(spokenCell: string, win: TimingWindow, allow: AllowList, warn: WarnFn): string {
  const isBv = win.id.includes("business") || win.id.includes("value");
  if (!isBv || spokenCell.startsWith("> **TODO:")) return spokenCell;
  const verdict = auditSpokenBusinessValue(spokenCell, allow);
  if (verdict.ok) return spokenCell;
  warn(`warn: invented claim ${verdict.invented ?? ""}`);
  return BV_AUDIT_TODO;
}

//#endregion

//#region visual cue derivation (no LLM — SCRIPT-02)

/** Screen id preferred for the live row when present in the vocabulary. */
const PREFERRED_LIVE_SCREEN = "widget-detail"; // catalog id (contracts/ui-screen-catalog.json)

/**
 * deriveVisualCue(win, index, manifest, catalog) — deterministic, no LLM.
 * UI absent → every cue degrades to the §4.2 no-UI TODO wording; live row
 * keeps its ▶ LIVE DEMO marker. UI present → live row carries the label plus a
 * real screen id; other rows cycle the allowed vocabulary by section order.
 */
export function deriveVisualCue(
  win: TimingWindow,
  index: number,
  manifest: AssemblyManifestView | null,
  catalog: UiScreenCatalog,
): string {
  if (!uiIncluded(manifest)) {
    return win.live ? `**${LIVE_DEMO_LABEL}** — ${noUiTodoCue()}` : noUiTodoCue();
  }
  const screens = allowedScreens(manifest, catalog);
  const liveScreen = screens.includes(PREFERRED_LIVE_SCREEN) ? PREFERRED_LIVE_SCREEN : (screens[0] ?? "");
  if (win.live) {
    return `**${LIVE_DEMO_LABEL}** \`${liveScreen}\` — moving capture, never a static title card`;
  }
  const screen = screens.length === 0 ? "" : (screens[index % screens.length] ?? screens[0] ?? "");
  return screen === "" ? `Visual: ${todoCueSuggestion(manifest, catalog)}` : `Visual: ${screen}`;
}

//#endregion

//#region markdown composition (§4.3 frontmatter + table)

/** "3:00"-style total display for the H1 (h:mm or mm:ss for <10 min). */
function formatTotal(totalMinutes: number): string {
  const totalSeconds = Math.round(totalMinutes * 60);
  return formatMMSS(totalSeconds).replace(/^0(?=[0-9]:)/, "");
}

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

interface ComposeParts {
  windows: TimingWindow[];
  cells: Array<{ spoken: string; visual: string }>;
  totalMinutes: number;
  timingSource: string;
  liveId: string | null;
  planHash: string;
  manifestHash: string;
  generatedAt: string;
  degraded: boolean;
}

const GENERATED_AT_RE = /^generated_at: .*$/m;

/** Compose script.md exactly per §4.3 (frontmatter, header comment, table). */
export function composeScriptMarkdown(parts: ComposeParts): { markdown: string; sections: ScriptSectionResult[] } {
  const { windows, cells, totalMinutes, timingSource, liveId, planHash, manifestHash, generatedAt, degraded } = parts;
  const totalDisplay = formatTotal(totalMinutes);
  const lines: string[] = [];
  lines.push("---");
  lines.push('script_version: "1.0.0"');
  lines.push(`total_minutes: ${totalMinutes}`);
  lines.push(`timing_source: ${timingSource}`);
  lines.push(`live_section: ${liveId ?? "none"}`);
  lines.push(`generated_at: ${generatedAt}`);
  lines.push(`source_plan_hash: ${planHash}`);
  lines.push(`source_manifest_hash: ${manifestHash}`);
  if (degraded) lines.push("fallback: RES-01 degraded — blank template");
  lines.push("---");
  lines.push("");
  lines.push(
    degraded
      ? `# Script — Pitch Video (${totalDisplay}) — DRAFT TEMPLATE — fill spoken text manually`
      : `# Script — Pitch Video (${totalDisplay}) — from winning_project_plan.md + assembly.manifest.json`,
  );
  lines.push("");
  lines.push("> Requirement IDs: SCRIPT-01, SCRIPT-02, SCRIPT-03, SCRIPT-04");
  lines.push(`> Timing: total ${totalDisplay} | sections ${windows.length} | live cue: \u25B6 LIVE DEMO`);
  lines.push("");
  lines.push("| Time | Section | Spoken | Visual |");
  lines.push("|------|---------|--------|--------|");
  const sections: ScriptSectionResult[] = [];
  windows.forEach((win, i) => {
    const cell = cells[i] ?? { spoken: genericTodoSpoken(win), visual: noUiTodoCue() };
    const titleCell = win.live ? `**${win.title}**` : win.title;
    lines.push(`| ${win.window} | ${titleCell} | ${cell.spoken} | ${cell.visual} |`);
    sections.push({
      id: win.id,
      title: win.title,
      minutes: win.minutes,
      start: win.start,
      end: win.end,
      live: win.live,
      spoken: cell.spoken,
      visual: cell.visual,
    });
  });
  return { markdown: `${lines.join("\n")}\n`, sections };
}

//#endregion

//#region blank timestamped template (SCRIPT-RES-01 fallback, §6.4)

/**
 * blankTemplate(timing, manifest) — the §6.4 fallback shape: accurate mm:ss
 * windows from the live TimingConfig, per-section TODO spoken cells, visual
 * cues that are ALREADY valid against manifest + catalog, and the preserved
 * ▶ LIVE DEMO row. Never empty; composed by the same composeScriptMarkdown.
 */
export function blankTemplate(
  timing: TimingConfig,
  manifest: AssemblyManifestView | null,
  opts: { totalMinutes: number; timingSource: string; planHash: string; manifestHash: string; generatedAt?: string },
): { markdown: string; sections: ScriptSectionResult[] } {
  const windows = computeWindows(timing);
  const cells = windows.map((win, i) => ({
    spoken: blankSpokenFor(win),
    visual: blankVisualFor(win, i, manifest),
  }));
  return composeScriptMarkdown({
    windows,
    cells,
    totalMinutes: opts.totalMinutes,
    timingSource: opts.timingSource,
    liveId: windows.find((w) => w.live)?.id ?? null,
    planHash: opts.planHash,
    manifestHash: opts.manifestHash,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    degraded: true,
  });
}

function blankSpokenFor(win: TimingWindow): string {
  if (win.id.includes("business") || win.id.includes("value")) {
    return "> **TODO:** Business Value spoken text — fill from winning_project_plan.md § Business Value";
  }
  if (win.live) {
    return "> **TODO:** Spoken text — generation failed — describe the assembled flow live";
  }
  if (win.id.includes("team") || win.id.includes("roadmap")) {
    return "> **TODO:** Team & ask — no source in winning_project_plan.md — fill manually";
  }
  return `> **TODO:** Spoken text — generation failed — fill from winning_project_plan.md for "${win.title}"`;
}

function blankVisualFor(win: TimingWindow, index: number, manifest: AssemblyManifestView | null): string {
  const catalog = loadUiScreenCatalog();
  return deriveVisualCue(win, index, manifest, catalog);
}

//#endregion

//#region atomic diff-before-write (SCRIPT-05 / §4.5)

/** Atomic tmp+rename write that SKIPS disk when bytes are unchanged. */
export function writeFileDiffAware(outPath: string, text: string): boolean {
  try {
    if (existsSync(outPath) && readFileSync(outPath, "utf8") === text) return false;
  } catch {
    /* unreadable previous file → rewrite it */
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, outPath);
  return true;
}

/**
 * Idempotence aid (§4.5): generated_at is the only non-input-derived byte.
 * When a re-run's body matches the existing file except for that line, reuse
 * the previous timestamp so unchanged inputs stay byte-identical on disk.
 */
export function reconcileGeneratedAt(markdown: string, previous: string | null): string {
  if (!previous) return markdown;
  const strip = (s: string) => s.replace(GENERATED_AT_RE, "generated_at: -");
  if (strip(markdown) !== strip(previous)) return markdown;
  const prevTs = GENERATED_AT_RE.exec(previous)?.[0]?.replace("generated_at: ", "").trim();
  return prevTs ? markdown.replace(GENERATED_AT_RE, `generated_at: ${prevTs}`) : markdown;
}

//#endregion

//#region SCRIPT-RES-01-wrapped generation entry point

/** Resolve which §4.1 precedence branch supplied the total (frontmatter string). */
export function timingSourceLabel(timing: TimingConfig | null, profile: EventProfile | null): string {
  if (timing?.total_minutes != null) return "timing.yaml";
  return extractProfileMaxMinutes(profile) != null ? "event_profile.json:video_limits.max_minutes" : "fallback 3";
}

/**
 * generateScript(input) — never throws (GOV-RES-01). One RES-01-wrapped LLM
 * call phrases spoken text; every failure (no transport, unresolved role,
 * timeout, forced degradation) collapses to blankTemplate. Visuals derive
 * without an LLM and pass through enforceVisuals so no invented screen or
 * static title card can ship (§6.5 guard 2).
 */
/**
 * The stub this module now writes by default (SCRIPT stub, 2026-09-09).
 *
 * Why a stub: this module is a pure function of winning_project_plan.md +
 * assembly.manifest.json. It never sees the built product, so every figure it
 * could put in a spoken cell is a plan-time aspiration — which is exactly how
 * previous entries shipped scripts naming steps and latencies the build never
 * had. The recording script is owned by the entry's DP-SCRIPT plan, which runs
 * after the build and measures the real thing (templates/demo-video-script.spec.md).
 *
 * The full timestamped table is still available behind `--full-draft` for the
 * Hour-0 timing skeleton; it is a draft, and this stub says so.
 */
export function renderScriptStub(opts: {
  totalMinutes: number;
  timingSource: string;
  windows: TimingWindow[];
  generatedAt?: string;
}): string {
  const rows = opts.windows
    .map((w) => `| ${w.window} | ${w.title}${w.live ? " (live demo)" : ""} | ${Math.round((w.minutes ?? 0) * 150)} |`)
    .join("\n");
  return `---
script_version: "2.0.0"
kind: stub
total_minutes: ${opts.totalMinutes}
timing_source: ${opts.timingSource}
generated_at: ${opts.generatedAt ?? new Date().toISOString()}
---

# Not the recording script — see \`demo-video-script.md\`

**The script you record from is \`demo-video-script.md\`, in this same folder**
(\`hackathons/hackathon-projects/<project>/\`), authored by the entry's **DP-SCRIPT**
design plan against \`templates/demo-video-script.spec.md\`.

This file is a stub on purpose. The chassis SCRIPT module is a pure function of
\`winning_project_plan.md\` + \`assembly.manifest.json\` — it never sees the built
product, so anything it wrote as spoken text would be a plan-time guess. Entries
have shipped videos naming pipeline steps, latencies and savings the build never
had. DP-SCRIPT instead runs the finished product twice, measures every number, and
writes prose that fits the event's runtime cap.

## What you still get here — the timing skeleton

Derived from \`${opts.timingSource}\`, total **${opts.totalMinutes} min**. Word budget
is at 150 wpm; DP-SCRIPT re-derives the cap from the event rules and may reshape these
sections entirely.

| Window | Section | Word budget |
|---|---|---|
${rows}

## If you want the old draft anyway

\`\`\`bash
script generate --plan winning_project_plan.md --manifest assembly.manifest.json --full-draft --out script.draft.md
\`\`\`

It is a draft. Do not read it into a microphone.
`;
}

export async function generateScript(input: GenerateScriptInput): Promise<ScriptResult> {
  const warn: WarnFn = input.warn ?? ((m) => console.warn(m));
  const warnings: string[] = [];
  const collectWarn = (m: string) => {
    warnings.push(m);
    warn(m);
  };

  // Timing: null → checked-in module-default config file (still config-driven).
  let timing = input.timing;
  if (timing === null || timing === undefined) {
    try {
      timing = validateTiming(parseTimingYaml(readFileSync(DEFAULT_TIMING_PATH, "utf8")), DEFAULT_TIMING_PATH);
    } catch (err) {
      collectWarn(`warn: module-default timing unreadable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (!timing || timing.sections.length === 0) {
    // Absolute last resort: cannot happen with the checked-in default file.
    throw new Error("script timing unavailable — provide --config timing.yaml");
  }

  // SCRIPT-03: exactly one live section; tolerate omission by assigning to the
  // earliest non-Problem section + warn (never silently title-card open).
  const rawWindows = computeWindows(timing);
  const existingLive = rawWindows.find((w) => w.live);
  let liveId: string | null = existingLive?.id ?? null;
  if (!existingLive) {
    const idx = rawWindows.findIndex((w) => !w.id.includes("problem"));
    const pick = idx >= 0 ? idx : rawWindows.length - 1;
    const cand = rawWindows[pick];
    if (cand) {
      liveId = cand.id;
      rawWindows[pick] = { ...cand, live: true };
      collectWarn("warn: no live:true in timing — assigned to Live Demo");
    }
  }
  const windows = rawWindows;

  const catalog = loadUiScreenCatalog();
  const allow = extractBusinessValue(input.plan ?? "");
  const allowed = allowedScreens(input.manifest, catalog);
  const totalMinutes = resolveTotalMinutes(timing, input.profile ?? null);
  const timingSource = timingSourceLabel(timing, input.profile ?? null);
  const planHash = sha16(input.plan ?? "");
  const manifestHash = sha16(JSON.stringify(input.manifest ?? null));

  const finalize = (
    composed: { markdown: string; sections: ScriptSectionResult[] },
    fallback: ScriptResult["fallback"],
  ): ScriptResult => {
    // §6.5 guard 2 post-pass: rewrite any invalid Visual cue / static live cue.
    const liveTitles = new Set(windows.filter((w) => w.live).map((w) => `**${w.title}**`));
    const enforced = enforceVisuals(
      composed.markdown,
      input.manifest,
      catalog,
      (row) => row.includes(LIVE_DEMO_LABEL) || [...liveTitles].some((t) => row.includes(t)),
      collectWarn,
    );
    let markdown = enforced.markdown;
    if (input.writeTo) {
      const prev = existsSync(input.writeTo) ? readFileSync(input.writeTo, "utf8") : null;
      markdown = reconcileGeneratedAt(markdown, prev);
    }
    const written = input.writeTo ? writeFileDiffAware(input.writeTo, markdown) : false;
    return {
      markdown,
      total_minutes: totalMinutes,
      timing_source: timingSource,
      live_section: liveId,
      sections: composed.sections,
      ...(fallback ? { fallback } : {}),
      warnings,
      written,
    };
  };

  try {
    // One RES-01-wrapped call for the WHOLE script (§6.1) — rhetoric only.
    const routing = getModelForRole(SCRIPT_GENERATOR_ROLE);
    if (!routing) throw new Error(`model role ${SCRIPT_GENERATOR_ROLE} unresolved in config/model-profiles.json`);
    if (!input.transport) throw new Error("no LLM transport available for script_generator (offline or unconfigured)");
    const prompt = renderScriptPrompt(input.plan ?? "", timingSummaryFor(windows), allowed);
    const wrapped = withResilience(() => input.transport!(prompt), SCRIPT_GEN_CONFIG);
    const out = await wrapped();
    if (isDegradedResult(out)) throw new Error(out.original_error ?? out.reason ?? "script LLM degraded");

    const draft = parseSpokenDraft(String(out), windows);
    const cells = windows.map((win, i) => {
      const raw = draft[win.id] ?? fallbackSpoken(win, input.plan ?? "", allow);
      const audited = auditBusinessValueCell(raw, win, allow, collectWarn);
      return { spoken: audited, visual: deriveVisualCue(win, i, input.manifest, catalog) };
    });
    return finalize(composeScriptMarkdown({ windows, cells, totalMinutes, timingSource, liveId, planHash, manifestHash, generatedAt: new Date().toISOString(), degraded: false }), undefined);
  } catch (e) {
    // DegradedResult or any throw → blank template (never throw, never empty).
    collectWarn(
      `warn: script generation failed — wrote blank timestamped template (headers only) [${e instanceof Error ? e.message : String(e)}]`,
    );
    const blank = blankTemplate(timing, input.manifest, {
      totalMinutes,
      timingSource,
      planHash,
      manifestHash,
    });
    return finalize(blank, "blank_template");
  }
}

//#endregion
