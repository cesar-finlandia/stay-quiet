// Requirement IDs: DECKGEN-01, DECKGEN-02, DECKGEN-05, DECKGEN-06, DECKGEN-REU-01, XCUT-08
// Slot population engine — DP-D2a §3.1 (slot→source mapping), §3.2 (TODO literal),
// §3.3 (PROV-01 byte-replacement), §3.6 (PIT-01/Marp format fit), §3.7 (idempotence).
//
// populateDeck({ planText, manifest, disclosureText, catalog, outDir }) is a PURE
// function of its inputs plus the checked-in templates/pitch-deck skeleton: it
// copies each skeleton file to outDir and replaces only the region bracketed by
// `<!-- SLOT n -->` … `<!-- /SLOT n -->` markers it owns (frontmatter is never
// touched — DECKGEN-05). Disclosure is a byte-verbatim copy between the
// `<!-- PROV-01:BEGIN -->` / `<!-- PROV-01:END -->` markers — never re-derived
// from the manifest (DECKGEN-02, contract #8 single source). Re-runs re-find
// their own markers, diff before write, and remove charts whose source figure
// disappeared — idempotent by construction (DECKGEN-06).
//
// No domain content anywhere (DECKGEN-REU-01): every emitted string is derived
// from the plan/manifest/catalog/disclosure inputs or is the generic §3.2 TODO
// literal. Never throws on missing/partial sources — degraded slots become the
// visible `> **TODO:**` marker instead (DECKGEN-01 never-fabrication, GOV-RES-01).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateDiagram, ManifestValidationError, type ComponentCatalog } from "./diagram.js";
import {
  extractBusinessValueFigures,
  generateRevenueChart,
  generateTamChart,
} from "./charts.js";
import { isDegradedResult } from "../../resilience/index.js";
import type { SlotPhraser } from "./phrase.js";

/** Skeleton source of truth (M12 PIT-01) — copied, never edited in place. */
const TEMPLATES_URL = new URL("../../../templates/pitch-deck/", import.meta.url);

/** Contract #7 frozen body headings, matched via ^##\s+<frozen>\s*$. */
const FROZEN_HEADINGS = [
  "Executive Pitch",
  "Problem Framing",
  "AI Solution",
  "Why Now",
  "Target Persona",
  "Business Value",
  "Architecture",
  "Suggested Module Emphasis",
] as const;

/** PIT-01 frozen ordered slots 01→08 (DP-D1 §3.1); lexical file names. */
const SLOT_FILES = [
  "01-title.md",
  "02-problem.md",
  "03-user.md",
  "04-demo.md",
  "05-architecture.md",
  "06-business-value.md",
  "07-ask-next-steps.md",
  "08-disclosure.md",
] as const;

type SlotFile = (typeof SLOT_FILES)[number];

const SLOT_TITLES: Record<SlotFile, string> = {
  "01-title.md": "Title / Tagline",
  "02-problem.md": "Problem",
  "03-user.md": "Specific User / Who Feels This Pain",
  "04-demo.md": "Live Demo",
  "05-architecture.md": "Architecture / Tech Overview",
  "06-business-value.md": "Business Value",
  "07-ask-next-steps.md": "Ask / Next Steps",
  "08-disclosure.md": "Disclosure & Provenance",
};

export interface BusinessValueFields {
  specific_user: string | null;
  tam_figure: string | null;
  revenue_model: string | null;
  why_ai: string | null;
}

/** Parsed contract #7 plan: frontmatter map (fallback) + frozen heading bodies (record). */
export interface ParsedPlan {
  raw: string;
  frontmatter: Record<string, string>;
  sections: Partial<Record<(typeof FROZEN_HEADINGS)[number], string>>;
}

export interface PopulateResult {
  outDir: string;
  /** Files whose bytes changed this run (atomic tmp+rename writes). */
  written: string[];
  /** Files left untouched — bytes identical to the previous run (no mtime bump). */
  skippedUnchanged: string[];
  warnings: string[];
}

/** Internal view of one slot-phraser outcome (§6.2 slot map input). */
export type PhrasedResult =
  | { ok: true; bullets: string[] }
  | { ok: false; reason: string; original_error: string | null; excerpt: string };

/**
 * DECKGEN-RES-02 §6.3 plan assessment — resolved BEFORE any LLM call. "full"
 * and "partial" proceed to per-slot population; "missing"/"empty" degrade to
 * the byte-identical PIT-01 skeleton fallback.
 */
export type PlanMode = "full" | "partial" | "missing" | "empty";

/** §6.3 check order: readable + non-empty + ≥1 frozen `##` heading? */
export function assessPlan(planText: string | null | undefined): PlanMode {
  const text = planText ?? "";
  if (text.trim().length === 0) return "empty";
  for (const heading of FROZEN_HEADINGS) {
    if (extractFrozenSection(text, heading) !== null) {
      const populated = FROZEN_HEADINGS.filter((h) => extractFrozenSection(text, h) !== null).length;
      return populated === FROZEN_HEADINGS.length ? "full" : "partial";
    }
  }
  return "empty"; // non-empty text but no frozen heading matched → degraded skeleton
}

/** §3.2 literal: greppable `> **TODO:**` blockquote — visible rendered AND in grep. */
function todoLine(slotName: string, reason: string, tail = "fill manually"): string {
  return `> **TODO:** ${slotName} — ${reason} — ${tail}.`;
}

/** Split prose into sentences on `.!?` followed by whitespace/end (forgiving). */
function sentences(text: string): string[] {
  return (text.replace(/\s+/g, " ").match(/[^.!?\n]+[.!?]*(\s|$)/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** First sentence, trimmed to ≤120 chars (§3.1 slot 01 rule). */
function firstSentenceWithin120(text: string): string | null {
  const first = sentences(text)[0];
  if (!first) return null;
  return first.length <= 120 ? first : `${first.slice(0, 117)}...`;
}

/** Parse YAML-ish plan frontmatter (`key: value`, quotes stripped); null when absent.
 *  Tolerates a leading requirement-ID comment block before the `---` fence. */
export function parsePlanFrontmatter(planText: string): Record<string, string> {
  const fenceStart = planText.match(/^---[ \t]*$/m);
  if (!fenceStart || fenceStart.index === undefined) return {};
  const rest = planText.slice(fenceStart.index);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rest);
  if (!m || !m[1]) return {};
  const map: Record<string, string> = {};
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = (kv[2] ?? "").trim().replace(/^["'](.*)["']$/, "$1");
    if (value) map[kv[1] as string] = value;
  }
  return map;
}

/** Extract one frozen `## <heading>` section body (to next level ≤2 heading/EOF). */
export function extractFrozenSection(planText: string, heading: string): string | null {
  const re = new RegExp(`^##[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*#*[ \\t]*$`, "im");
  const m = re.exec(planText);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const next = planText.slice(start).match(/^#{1,2}[ \t]+\S/im);
  const body =
    next && next.index !== undefined ? planText.slice(start, start + next.index) : planText.slice(start);
  const trimmed = body.trim();
  return trimmed ? trimmed : null;
}

/** Full contract #7 parse — body headings are the record; frontmatter fallback only. */
export function parseWinningPlan(planText: string): ParsedPlan {
  const sections: ParsedPlan["sections"] = {};
  for (const heading of FROZEN_HEADINGS) {
    const body = extractFrozenSection(planText, heading);
    if (body !== null) sections[heading] = body;
  }
  return { raw: planText, frontmatter: parsePlanFrontmatter(planText), sections };
}

/** All four Business Value sub-fields (charts.ts owns tam/revenue; never invented). */
export function extractBusinessValueFields(planText: string): BusinessValueFields {
  const figures = extractBusinessValueFigures(planText);
  const section = extractFrozenSection(planText, "Business Value") ?? "";
  const readField = (key: string): string | null => {
    const m = section.match(new RegExp(`^[-* \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, "im"));
    const value = m?.[1]?.trim();
    return value ? value : null;
  };
  return {
    specific_user: readField("specific_user"),
    tam_figure: figures.tam_figure,
    revenue_model: figures.revenue_model,
    why_ai: readField("why_ai"),
  };
}

/** First `r/<subreddit>, <rough_date>` fragment in a §3.1 evidence line; null when absent. */
export function extractEvidenceLine(text: string): string | null {
  const m = text.match(/r\/[A-Za-z0-9_]+[^\n]*/);
  if (!m || !m[0]) return null;
  const date = m[0].match(/\d{4}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\b\d{4}\b/i);
  const sub = m[0].match(/r\/[A-Za-z0-9_]+/) as RegExpMatchArray;
  return date && date[0] ? `${sub[0]}, ${date[0].trim()}` : (sub[0] ?? null);
}

/* ------------------------------------------------------------------ */
/* RES-01 phrasing plumbing — excerpts, fallback literal, audits.      */
/* ------------------------------------------------------------------ */

/** Raw plan excerpt handed to the phraser for one textual slot (§6.1). */
export function slotExcerpt(file: SlotFile, plan: ParsedPlan): string {
  switch (file) {
    case "01-title.md":
      return [plan.frontmatter["title"], plan.sections["Executive Pitch"]]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join("\n\n");
    case "02-problem.md":
      return plan.sections["Problem Framing"] ?? "";
    case "03-user.md":
      return [plan.sections["Target Persona"], plan.sections["Why Now"]]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join("\n\n");
    case "06-business-value.md":
      return plan.sections["Business Value"] ?? "";
    default:
      return ""; // slots 04/05/08 are never LLM-phrased (§6.2 slot map)
  }
}

/** §6.2 fallback literal — greppable TODO + raw excerpt preserved in blockquote. */
function llmFallbackLines(
  slotName: string,
  reason: string,
  originalError: string | null,
  excerpt: string,
): string[] {
  const detail = [reason, originalError ? String(originalError) : null].filter(Boolean).join("; ");
  const head = todoLine(
    slotName,
    `LLM phrasing failed (RES-01 fallback${detail ? ` — ${detail}` : ""})`,
    "raw excerpt preserved below",
  );
  const lines = (excerpt ?? "").trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  return [head, ">", ...lines.map((l, i) => `${i === 0 ? "> Raw excerpt: " : "> "}${l.trim()}`)];
}

/** Never-fabrication audit (§9.5 spirit): every numeric token must exist in the excerpt. */
export function phrasedFiguresGroundedInExcerpt(bullets: string[], excerpt: string): boolean {
  const tokens = bullets.join(" ").match(/\d+(?:[.,]\d+)?/g) ?? [];
  return tokens.every((t) => excerpt.includes(t));
}

/* ------------------------------------------------------------------ */
/* Slot interiors — each returns the marker-region body for one slot.  */
/* Every path yields ≥1 bullet or ≥1 `> **TODO:**` line (never blank). */
/* ------------------------------------------------------------------ */

/** Slot 01 — frontmatter.title → Executive Pitch first sentence → TODO (≤120 chars). */
export function buildTitleSlot(plan: ParsedPlan, phrased?: PhrasedResult | null): string {
  if (phrased && !phrased.ok) {
    return llmFallbackLines("Title / Tagline", phrased.reason, phrased.original_error, phrased.excerpt).join("\n");
  }
  if (phrased?.ok && phrased.bullets.length > 0) {
    return phrased.bullets.map((b) => `- ${b.replace(/^[-*\s]+/, "")}`).join("\n");
  }
  const fromFrontmatter = plan.frontmatter["title"]?.trim() || null;
  const title =
    (fromFrontmatter && firstSentenceWithin120(fromFrontmatter)) ??
    firstSentenceWithin120(plan.sections["Executive Pitch"] ?? "");
  if (!title) {
    return todoLine(
      "Title / Tagline",
      "no frontmatter.title and no ## Executive Pitch sentence in winning_project_plan.md",
    );
  }
  return `**${title}**`;
}

/** Slot 02 — LLM-phrased or up-to-3 EXTRACTIVE Problem Framing bullets + evidence line. */
export function buildProblemSlot(plan: ParsedPlan, phrased?: PhrasedResult | null): string {
  const body = plan.sections["Problem Framing"];
  if (!body) {
    return todoLine("Problem", "no ## Problem Framing section in winning_project_plan.md");
  }
  const evidence = extractEvidenceLine(body);
  if (phrased && !phrased.ok) {
    return ["## Problem", "", ...llmFallbackLines("Problem", phrased.reason, phrased.original_error, phrased.excerpt)].join("\n");
  }
  if (phrased?.ok && phrased.bullets.length > 0) {
    const lines = [...phrased.bullets.map((b) => `- ${b.replace(/^[-*\s]+/, "")}`)];
    if (evidence) lines.push(`- Evidence: ${evidence}`); // mechanical, PGM-07 — never phrased away
    return ["## Problem", "", ...lines].join("\n");
  }
  // Evidence/corroborating sentences contribute their descriptive tail as a
  // framing bullet (verbatim minus the label + subreddit/date prefix); the
  // structured `r/<subreddit>, <rough_date>` line is emitted separately.
  const framingBullets: string[] = [];
  for (const s of sentences(body)) {
    let t = s;
    if (/^(evidence|corroborating)\b/i.test(t)) {
      t = t
        .replace(/^(?:corroborating(?:\s+\w+)?)\s*:\s*/i, "")
        .replace(/^evidence\s*:\s*/i, "")
        .replace(/^r\/[A-Za-z0-9_]+\s*,\s*[\d-]+\s*[—:-]\s*/i, "")
        .replace(/^r\/[A-Za-z0-9_]+\s*[—:-]\s*/i, "");
    }
    if (!t.trim()) continue;
    framingBullets.push(`- ${t.trim()}`);
    if (framingBullets.length >= 3) break;
  }
  const lines = [...framingBullets];
  if (evidence) lines.push(`- Evidence: ${evidence}`);
  return ["## Problem", "", ...(lines.length > 0 ? lines : [`- ${sentences(body)[0]}`])].join("\n");
}

/** Slot 03 — Target Persona → Business Value specific_user → frontmatter.persona → TODO. */
export function buildUserSlot(plan: ParsedPlan, phrased?: PhrasedResult | null): string {
  const personaBody = plan.sections["Target Persona"] ?? null;
  const personaFirst = personaBody ? (sentences(personaBody)[0] ?? null) : null;
  const fields = extractBusinessValueFields(plan.raw);
  const label = personaFirst ?? fields.specific_user ?? plan.frontmatter["persona"] ?? null;
  if (phrased && !phrased.ok) {
    return [
      "## Specific User",
      "",
      ...llmFallbackLines("Specific User / Who Feels This Pain", phrased.reason, phrased.original_error, phrased.excerpt),
    ].join("\n");
  }
  if (phrased?.ok && phrased.bullets.length > 0) {
    return ["## Specific User", "", ...phrased.bullets.map((b) => `- ${b.replace(/^[-*\s]+/, "")}`)].join("\n");
  }
  if (!label) {
    return todoLine(
      "Specific User / Who Feels This Pain",
      "no ## Target Persona, specific_user, or frontmatter.persona in winning_project_plan.md",
    );
  }
  const whyNow = plan.sections["Why Now"] ? (sentences(plan.sections["Why Now"] as string)[0] ?? null) : null;
  const lines = [`## Specific User`, "", `- Specific user: ${label}`];
  if (personaFirst && personaFirst !== label) lines.push(`- Pain frequency: ${personaFirst}`);
  if (whyNow) lines.push(`- Why now: ${whyNow}`);
  return lines.join("\n");
}

/** contracts/ui-screen-catalog.json (M02/M13 co-owned) — loaded once, never copied. */
let cachedUiScreens: Array<{ id: string; title?: string }> | null = null;
function loadUiScreenCatalog(): Array<{ id: string; title?: string }> {
  if (!cachedUiScreens) {
    const url = new URL("../../../contracts/ui-screen-catalog.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { screens?: Array<{ id: string; title?: string }> };
    cachedUiScreens = parsed.screens ?? [];
  }
  return cachedUiScreens;
}

/**
 * Assembled UI screen names (names only, §3.1 slot 04) — non-null exactly when a
 * UI-bearing component is included in the manifest (directly or expanded through
 * the component-catalog sub_components). Never invents a screen.
 */
export function assembledUiScreenNames(manifest: unknown, catalog: ComponentCatalog): string[] | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const components = (manifest as { components?: Array<{ id: string; included: boolean }> }).components;
  if (!Array.isArray(components)) return null;
  const included = new Set(components.filter((c) => c && c.included).map((c) => c.id));
  let uiIncluded = included.has("platform/ui");
  if (!uiIncluded && included.has("platform")) {
    const entry = catalog.components.find((c) => c.id === "platform");
    uiIncluded = (entry?.sub_components ?? []).includes("platform/ui");
  }
  if (!uiIncluded) return null;
  return loadUiScreenCatalog().map((s) => s.title ?? s.id);
}

/** Slot 04 — cue line + assembled screen names; URL left TODO when absent; never blank. */
export function buildDemoSlot(manifest: unknown, catalog: ComponentCatalog): string {
  const screens = assembledUiScreenNames(manifest, catalog);
  const lines = ["▶ LIVE DEMO — moving capture (see SCRIPT)", ""];
  if (screens && screens.length > 0) {
    lines.push(`- Assembled UI screens: ${screens.join(", ")}`);
  } else {
    lines.push(
      todoLine(
        "Demo screens",
        "no UI component selected in assembly.manifest.json",
        "add platform/ui or point to the live demo URL manually",
      ),
    );
  }
  lines.push(todoLine("Demo URL / QR", "no deploy URL yet", "paste the deployed URL or QR before recording"));
  return lines.join("\n");
}

/** Slot 05 — `## Architecture` verbatim + module emphasis + diagram/chart includes. */
export function buildArchitectureSlot(
  plan: ParsedPlan,
  diagram: string | null,
  manifestMissing = false,
): string {
  const arch = plan.sections["Architecture"]?.trim() || null;
  const emphasis = plan.sections["Suggested Module Emphasis"]?.trim() || null;
  const lines: string[] = [];
  if (arch) {
    lines.push(arch, "");
  } else {
    lines.push(todoLine("Architecture / Tech Overview", "no ## Architecture section in winning_project_plan.md"), "");
  }
  if (emphasis) {
    lines.push(`Module emphasis (advisory): ${emphasis}`, "");
  }
  if (diagram !== null) {
    // DECKGEN-03/04 injection: include reference (path resolves from out dir)
    // plus a fenced copy for Marp portability per §3.4 step 5.
    lines.push("![architecture diagram](./diagram.mmd)", "", "```mermaid", diagram.replace(/\n$/, ""), "```", "");
  } else {
    lines.push(todoLine("Architecture diagram", manifestMissing ? "no manifest — run assembly first" : "no valid assembly.manifest.json — run assembly first"));
  }
  return lines.join("\n").replace(/\n+$/, "");
}

/** Slot 06 — four verbatim sub-bullets; any missing figure → that bullet is TODO. */
export function buildBusinessValueSlot(
  plan: ParsedPlan,
  chartsEmitted: { tam: boolean; revenue: boolean },
  phrased?: PhrasedResult | null,
): string {
  const fields = extractBusinessValueFields(plan.raw);
  // §7: phrasing never selects Business Value figures — on a degraded result the
  // mechanical extraction below still runs; on success the bullets are audited
  // (every numeric token grounded in the excerpt) before replacing anything.
  if (phrased && !phrased.ok && phrased.excerpt.trim() === "") {
    return llmFallbackLines("Business Value", phrased.reason, phrased.original_error, phrased.excerpt).join("\n");
  }
  if (phrased?.ok && phrased.bullets.length > 0) {
    // Success path — but only when the phrased bullets are grounded: every
    // numeric token must already exist in the plan excerpt (§9.5 audit spirit).
    if (!phrasedFiguresGroundedInExcerpt(phrased.bullets, slotExcerpt("06-business-value.md", plan))) {
      /* fall through to mechanical extraction — figures stay verbatim (§7) */
    } else {
      const lines = ["## Business Value", "", ...phrased.bullets.map((b) => `- ${b.replace(/^[-*\s]+/, "")}`)];
      if (chartsEmitted.tam) lines.push("", "![TAM](./chart-tam.svg)");
      if (chartsEmitted.revenue) lines.push("", "![Revenue model](./chart-revenue.svg)");
      return lines.join("\n");
    }
  }
  const missing = (field: string, slotName: string, reason: string): string =>
    `- ${field}: ${todoLine(slotName, reason)}`;
  const lines = [
    "## Business Value",
    "",
    fields.specific_user
      ? `- Specific user: ${fields.specific_user}`
      : missing("Specific user", "Specific user", "no specific_user in winning_project_plan.md §## Business Value"),
    fields.tam_figure
      ? `- TAM: ${fields.tam_figure}`
      : missing("TAM", "Market size", "no tam_figure in winning_project_plan.md §## Business Value"),
    fields.revenue_model
      ? `- Revenue model: ${fields.revenue_model}`
      : missing("Revenue model", "Revenue model", "no revenue_model in winning_project_plan.md §## Business Value"),
    fields.why_ai
      ? `- Why AI: ${fields.why_ai}`
      : missing("Why AI", "Why AI", "no why_ai in winning_project_plan.md §## Business Value"),
  ];
  if (chartsEmitted.tam) lines.push("", "![TAM](./chart-tam.svg)");
  if (chartsEmitted.revenue) lines.push("", "![Revenue model](./chart-revenue.svg)");
  return lines.join("\n");
}

/** Slot 07 — Ask/Roadmap sub-heading body when present, else the canonical Team TODO block. */
export function buildAskSlot(plan: ParsedPlan): string {
  const heading = plan.raw.match(/^#{1,3}[ \t]+[^\n]*\b(ask|roadmap|next[- ]steps)\b[^\n]*$/im);
  if (heading && heading.index !== undefined) {
    const start = heading.index + heading[0].length;
    const next = plan.raw.slice(start).match(/^#{1,6}[ \t]+\S/im);
    const body =
      next && next.index !== undefined
        ? plan.raw.slice(start, start + next.index)
        : plan.raw.slice(start);
    const trimmed = body.trim();
    if (trimmed) return trimmed;
  }
  const tracks = (plan.frontmatter["sponsor_tracks"] ?? "")
    .replace(/^[\[\"']+|[\]\""]+$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']+|["']+$/g, ""))
    .filter(Boolean);
  const lines = [
    todoLine(
      "Ask / Next Steps",
      "no dedicated Ask or Team section in winning_project_plan.md (team roster is not part of PGM-09 contract #7)",
      "fill manually with members, roles, and ask",
    ),
  ];
  if (tracks.length > 0) lines.push("", `- Sponsor tracks (from frontmatter): ${tracks.join(", ")}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Output assembly — DECKGEN-05 format fit + DECKGEN-06 idempotence.   */
/* ------------------------------------------------------------------ */

function readTemplate(file: string): string {
  return readFileSync(new URL(file, TEMPLATES_URL), "utf8");
}

/** Atomic tmp+rename write that SKIPS the disk when bytes are unchanged. */
function writeFileAtomic(outPath: string, text: string): boolean {
  if (existsSync(outPath) && readFileSync(outPath, "utf8") === text) return false;
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, outPath);
  return true;
}

const slotMarkers = (slotNo: string) => ({
  begin: `<!-- SLOT ${slotNo} -->`,
  end: `<!-- /SLOT ${slotNo} -->`,
});

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * Copy one PIT-01 skeleton slide into its populated form: Marp frontmatter and
 * the requirement-ID header stay untouched; the TODO(EVENT)/placeholder block is
 * REPLACED (never left alongside — §3.2 rule table) by the `<!-- SLOT nn -->`
 * bracketed interior. On re-runs over an already-populated file, the existing
 * markers are re-found and only their interior changes (marker re-entrance).
 */
export function renderSlotFile(template: string, slotNo: string, fileName: SlotFile, content: string): string {
  const { begin, end } = slotMarkers(slotNo);
  const beginIdx = template.indexOf(begin);
  const endIdx = template.indexOf(end);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    return (
      template.slice(0, beginIdx + begin.length) +
      "\n" +
      content.trim() +
      "\n" +
      template.slice(endIdx)
    );
  }
  // Fresh skeleton: everything from the first HTML comment onward is replaced.
  const fm = FRONTMATTER_RE.exec(template);
  const head = fm
    ? (() => {
        const rest = template.slice(fm[0].length);
        const commentStart = rest.indexOf("<!--");
        const kept = commentStart >= 0 ? rest.slice(0, commentStart) : rest;
        return kept.replace(/\s+$/, "").replace(/\{\{slot_title\}\}/g, SLOT_TITLES[fileName]) + "\n";
      })()
    : "";
  const front = fm ? fm[0].replace(/\n$/, "") : "";
  const bodyHead = head.replace(/^\n+/, "").replace(/\n+$/, "");
  return `${front}\n\n${bodyHead}\n\n${begin}\n${content.trim()}\n${end}\n`;
}

export const DISCLOSURE_BEGIN_RE = /<!--\s*PROV-01:BEGIN[^>]*>/;
export const DISCLOSURE_END_RE = /<!--\s*PROV-01:END[^>]*>/;

/** Bytes strictly inside the two canonical markers of an 08-disclosure file.
 *  The single newline immediately after the BEGIN marker is marker spacing,
 *  not content — it is stripped so the result equals the disclosure bytes the
 *  writer inserted (byte-equality modulo trailing newline, DECKGEN-AC-02). */
export function extractDisclosureRegion(text: string): string | null {
  const b = DISCLOSURE_BEGIN_RE.exec(text);
  const e = DISCLOSURE_END_RE.exec(text);
  if (!b || !e || b.index === undefined || e.index === undefined || e.index < b.index) return null;
  return text.slice(b.index + b[0].length + (text[b.index + b[0].length] === "\n" ? 1 : 0), e.index);
}

/** Single trailing-newline normalization — no other byte is ever touched. */
function normalizeTrailingNewline(text: string): string {
  return text.replace(/\n+$/, "\n");
}

/**
 * DECKGEN-02 — replace exactly the bytes between the PROV-01 markers with the
 * disclosure.md bytes verbatim (canonical bare markers kept in the output so
 * re-runs re-find them). Never parses the manifest to render disclosure.
 * When disclosureText is null/empty the placeholder is left untouched + warn.
 */
export function renderDisclosureFile(
  template: string,
  disclosureText: string | null | undefined,
): { text: string; warned: boolean } {
  const b = DISCLOSURE_BEGIN_RE.exec(template);
  const e = DISCLOSURE_END_RE.exec(template);
  if (!b || !e || b.index === undefined || e.index === undefined || e.index < b.index) {
    return { text: template, warned: true };
  }
  if (disclosureText == null || disclosureText.trim() === "") {
    return { text: template, warned: true }; // PIT-03 placeholder stays byte-identical
  }
  const body = normalizeTrailingNewline(disclosureText);
  const text =
    template.slice(0, b.index) +
    "<!-- PROV-01:BEGIN -->\n" +
    body +
    "<!-- PROV-01:END -->" +
    template.slice(e.index + e[0].length);
  return { text, warned: false };
}

/**
 * DECKGEN-05 concatenation: 01→08 in lexical order, Marp frontmatter kept only
 * on the first file, subsequent slides separated by exactly one `---` break.
 */
export function concatDeck(slotTexts: string[]): string {
  if (slotTexts.length === 0) return "";
  const first = slotTexts[0];
  if (first === undefined) return "";
  const rest = slotTexts.slice(1);
  const stripFrontmatter = (t: string) => t.replace(FRONTMATTER_RE, "").replace(/^\n+/, "");
  const parts = [first.replace(/\n+$/, ""), ...rest.map((t) => stripFrontmatter(t).replace(/\n+$/, ""))];
  return parts.join("\n\n---\n\n") + "\n";
}

export interface PopulateDeckInput {
  /** winning_project_plan.md bytes (contract #7); may be empty — TODOs result. */
  planText: string;
  /** True when --plan could not be read at all (ENOENT) — §6.3 "missing" warn. */
  planMissing?: boolean;
  /** Parsed assembly.manifest.json (contract #6) or null when absent. */
  manifest: unknown;
  /** disclosure.md bytes (PROV-01 contract #8) — null leaves the placeholder. */
  disclosureText?: string | null;
  /** contracts/component-catalog.json parsed bytes (DP-G §6 single source). */
  catalog: ComponentCatalog;
  /** Output directory; created on demand. Never a templates/ path. */
  outDir: string;
  /**
   * Optional RES-01-wrapped bullet phraser (DECKGEN-RES-01, §6.1/§6.2). When
   * omitted — or via CLI `--no-llm` — slots use extractive bullets only.
   * Slots 04/05/08 are never LLM-phrased. Every DegradedResult or throw maps
   * to the §3.2 literal TODO + raw-excerpt blockquote; populateDeck itself
   * never rethrows phrasing failures.
   */
  phraser?: SlotPhraser;
}

/** Chart/diagram artifacts this module owns inside outDir (for stale cleanup). */
const DERIVED_ARTIFACTS = ["diagram.mmd", "chart-tam.svg", "chart-revenue.svg"] as const;

/** Textual slots eligible for LLM phrasing (§6.1: 01–03, 06; 04/05/08 never). */
const PHRASABLE_SLOTS: ReadonlyArray<SlotFile> = [
  "01-title.md",
  "02-problem.md",
  "03-user.md",
  "06-business-value.md",
];

/**
 * Resolve one PhrasedResult per phrasable slot. The phraser is expected to be
 * RES-01-wrapped already (phrase.ts), but even a THROWN DegradedResult is
 * caught here and mapped to the same {ok:false} shape — never rethrown (§6.2
 * outer-driver rule, RES-RES-03).
 */
async function resolvePhrasedSlots(
  phraser: SlotPhraser | undefined,
  plan: ParsedPlan,
): Promise<Partial<Record<SlotFile, PhrasedResult>>> {
  const out: Partial<Record<SlotFile, PhrasedResult>> = {};
  if (!phraser) return out;
  for (const file of PHRASABLE_SLOTS) {
    const excerpt = slotExcerpt(file, plan);
    try {
      const res = await phraser(String(Number(file.slice(0, 2))), excerpt);
      out[file] = isDegradedResult(res)
        ? { ok: false, reason: res.reason, original_error: res.original_error, excerpt }
        : { ok: true, bullets: res.bullets.filter((b) => typeof b === "string" && b.trim() !== "") };
    } catch (e) {
      out[file] = { ok: false, reason: "deck_llm_failed", original_error: e instanceof Error ? e.message : String(e), excerpt };
    }
  }
  return out;
}

/**
 * DECKGEN-RES-02 skeleton fallback (§6.3): byte-identical copies of the
 * checked-in templates/pitch-deck/*.md to --out, deck.md = skeleton concat,
 * diagram.mmd still rendered when a valid manifest is present, charts none.
 * Exit-success shape — warnings only.
 */
function populateSkeletonOnly(input: PopulateDeckInput & { planMode: "missing" | "empty"; warnings: string[] }): PopulateResult {
  const { manifest, catalog, outDir, planMode, warnings } = input;
  const written: string[] = [];
  const skippedUnchanged: string[] = [];
  warnings.push(
    planMode === "missing"
      ? "warn: winning_project_plan.md not found — populating from PIT-01 skeleton only"
      : "warn: winning_project_plan.md empty — degraded to PIT-01 skeleton",
  );
  const skeletons: string[] = [];
  SLOT_FILES.forEach((fileName, i) => {
    const bytes = readTemplate(fileName);
    skeletons.push(bytes);
    if (writeFileAtomic(join(outDir, fileName), bytes)) written.push(fileName);
    else skippedUnchanged.push(fileName);
    void i;
  });
  // Disclosure placeholder stays byte-identical to the skeleton (no warn here:
  // the missing-disclosure case is reported below like the normal path).
  let diagram: string | null = null;
  try {
    diagram = generateDiagram(manifest, catalog);
  } catch (err) {
    diagram = null;
    if (!(err instanceof ManifestValidationError)) {
      warnings.push(`warn: diagram not generated from manifest — omitted (${String(err)})`);
    }
  }
  if (diagram !== null && writeFileAtomic(join(outDir, "diagram.mmd"), diagram)) written.push("diagram.mmd");
  else if (diagram !== null) skippedUnchanged.push("diagram.mmd");
  if (writeFileAtomic(join(outDir, "deck.md"), concatDeck(skeletons))) written.push("deck.md");
  else skippedUnchanged.push("deck.md");
  try {
    const appendix = readTemplate("97-appendix.md");
    if (writeFileAtomic(join(outDir, "97-appendix.md"), appendix)) written.push("97-appendix.md");
    else skippedUnchanged.push("97-appendix.md");
  } catch {
    /* optional file */
  }
  if (input.disclosureText == null || String(input.disclosureText).trim() === "") {
    warnings.push(
      "warn: disclosure.md not found — slot 08 left as PIT-03 placeholder; run `provo generate` then re-run `deckgen populate`.",
    );
  }
  for (const w of warnings) console.warn(w);
  return { outDir, written, skippedUnchanged, warnings };
}

/**
 * populateDeck — pure function of (plan bytes, manifest, disclosure bytes,
 * catalog, skeleton) → populated slot files + deck.md + diagram.mmd + charts.
 * Re-runnable over an existing out dir without --force (DECKGEN-06): markers
 * re-found, diff-before-write, atomic tmp+rename everywhere, stale derived
 * charts removed with a warn. Never throws on missing/partial sources.
 *
 * DECKGEN-RES-02 (§6.3): the plan is assessed BEFORE any LLM call — a missing
 * or empty/no-frozen-heading plan degrades to a byte-identical copy of the
 * checked-in templates/pitch-deck skeleton (plus diagram.mmd when the manifest
 * validates); a partial plan falls through to per-slot §3.1 logic.
 */
export async function populateDeck(input: PopulateDeckInput): Promise<PopulateResult> {
  const { planText, manifest, catalog, outDir } = input;
  const warnings: string[] = [];
  const written: string[] = [];
  const skippedUnchanged: string[] = [];

  mkdirSync(outDir, { recursive: true });

  // DECKGEN-RES-02 check order — early, before any phraser invocation.
  const planMode: PlanMode = input.planMissing ? "missing" : assessPlan(planText);
  if (planMode === "missing" || planMode === "empty") {
    return populateSkeletonOnly({ ...input, planMode, warnings });
  }

  const plan = parseWinningPlan(planText ?? "");

  // DECKGEN-RES-01 — resolve phraser outcomes for the textual slots up front so
  // builders stay synchronous; any throw here is caught per slot (§6.2).
  const phrased = await resolvePhrasedSlots(input.phraser, plan);


  // DECKGEN-03/04 derived artifacts (never hand-drawn; null → TODO instead).
  let diagram: string | null = null;
  try {
    diagram = generateDiagram(manifest, catalog);
  } catch (err) {
    warnings.push(
      err instanceof ManifestValidationError
        ? `warn: assembly.manifest.json invalid — diagram omitted (${err.errors.map((e) => e.message).join("; ")})`
        : `warn: diagram not generated from manifest — omitted (${String(err)})`,
    );
    diagram = null;
  }
  const figures = extractBusinessValueFigures(plan.raw);
  const tamSvg = generateTamChart(figures.tam_figure);
  const revenueSvg = generateRevenueChart(figures.revenue_model);

  // Per-slot interiors (§3.1 mapping; every builder returns ≥1 line).
  const interiors = new Map<SlotFile, string>();
  interiors.set("01-title.md", buildTitleSlot(plan, phrased["01-title.md"]));
  interiors.set("02-problem.md", buildProblemSlot(plan, phrased["02-problem.md"]));
  interiors.set("03-user.md", buildUserSlot(plan, phrased["03-user.md"]));
  interiors.set("04-demo.md", buildDemoSlot(manifest, catalog));
  interiors.set("05-architecture.md", buildArchitectureSlot(plan, diagram, manifest == null));
  interiors.set(
    "06-business-value.md",
    buildBusinessValueSlot(plan, { tam: tamSvg !== null, revenue: revenueSvg !== null }, phrased["06-business-value.md"]),
  );
  interiors.set("07-ask-next-steps.md", buildAskSlot(plan));

  // Slots 01→07: copy skeleton, bracket the content region, write atomically.
  const slotOutputs: string[] = [];
  SLOT_FILES.forEach((fileName, i) => {
    const slotNo = String(i + 1).padStart(2, "0");
    if (fileName === "08-disclosure.md") return; // handled below (DECKGEN-02)
    const rendered = renderSlotFile(readTemplate(fileName), slotNo, fileName, interiors.get(fileName) as string);
    slotOutputs.push(rendered);
    const outPath = join(outDir, fileName);
    if (writeFileAtomic(outPath, rendered)) written.push(fileName);
    else skippedUnchanged.push(fileName);
  });

  // Slot 08 — byte-verbatim PROV-01 replacement (or placeholder + warn).
  const disclosure = renderDisclosureFile(readTemplate("08-disclosure.md"), input.disclosureText ?? null);
  if (disclosure.warned && input.disclosureText != null && String(input.disclosureText).trim() !== "") {
    warnings.push("warn: 08-disclosure.md has no PROV-01 markers — left untouched");
  }
  slotOutputs.push(disclosure.text);
  const disclosureOut = join(outDir, "08-disclosure.md");
  if (input.disclosureText == null || String(input.disclosureText).trim() === "") {
    warnings.push(
      "warn: disclosure.md not found — slot 08 left as PIT-03 placeholder; run `provo generate` then re-run `deckgen populate`.",
    );
  }
  if (writeFileAtomic(disclosureOut, disclosure.text)) written.push("08-disclosure.md");
  else skippedUnchanged.push("08-disclosure.md");

  // Derived artifacts written alongside the slots (paths resolve from outDir).
  if (diagram !== null && writeFileAtomic(join(outDir, "diagram.mmd"), diagram)) written.push("diagram.mmd");
  else if (diagram !== null) skippedUnchanged.push("diagram.mmd");
  if (tamSvg !== null && writeFileAtomic(join(outDir, "chart-tam.svg"), tamSvg)) written.push("chart-tam.svg");
  else if (tamSvg !== null) skippedUnchanged.push("chart-tam.svg");
  if (revenueSvg !== null && writeFileAtomic(join(outDir, "chart-revenue.svg"), revenueSvg)) {
    written.push("chart-revenue.svg");
  } else if (revenueSvg !== null) skippedUnchanged.push("chart-revenue.svg");

  // Stale-artifact deletion: source figure/manifest disappeared since last run.
  const emitted = new Set<string>([
    ...(diagram !== null ? ["diagram.mmd"] : []),
    ...(tamSvg !== null ? ["chart-tam.svg"] : []),
    ...(revenueSvg !== null ? ["chart-revenue.svg"] : []),
  ]);
  for (const artifact of DERIVED_ARTIFACTS) {
    const p = join(outDir, artifact);
    if (!emitted.has(artifact) && existsSync(p)) {
      try {
        rmSync(p);
        warnings.push(`warn: stale ${artifact} removed — its source figure is no longer present`);
      } catch {
        warnings.push(`warn: stale ${artifact} could not be removed`);
      }
    }
  }

  // deck.md — concatenated deliverable (frontmatter only on the first slide).
  const deckPath = join(outDir, "deck.md");
  if (writeFileAtomic(deckPath, concatDeck(slotOutputs))) written.push("deck.md");
  else skippedUnchanged.push("deck.md");

  // 97-appendix copied verbatim when the skeleton ships it — never populated.
  try {
    const appendix = readTemplate("97-appendix.md");
    if (writeFileAtomic(join(outDir, "97-appendix.md"), appendix)) written.push("97-appendix.md");
    else skippedUnchanged.push("97-appendix.md");
  } catch {
    /* optional file — absence is not a warning */
  }

  for (const w of warnings) console.warn(w);
  return { outDir, written, skippedUnchanged, warnings };
}
