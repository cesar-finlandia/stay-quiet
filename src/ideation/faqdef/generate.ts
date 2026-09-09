// Requirement IDs: FAQDEF-01, FAQDEF-02, FAQDEF-03, FAQDEF-RES-01, FAQDEF-RES-02,
// PROFILE-05, GOV-RES-02, XCUT-08 | Owned by M14 step 4 (DP-D2b §5.1–§5.4, §6.1, §8.2)
// Question-generation pipeline: plan + manifest + PROV architecture summary
// (REUSED verbatim — never re-derived) → rendered generic prompt → RES-01-wrapped
// LLM → RES-04-validated Q&A sheet with anti-fabrication grounding and axis
// coverage enforcement. Absent inputs degrade gracefully (PROFILE-05); the LLM
// path failing degrades to the static fallback checklist — never crash.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validate } from "../../resilience/index.js";
import type { DegradedResult } from "../../resilience/index.js";
import {
  resilientFaqdefCall,
  defaultCallLlm,
  type FaqdefLlm,
} from "./llm.js";
import { validateGrounding } from "./grounding.js";
import {
  renderSheetMarkdown,
  validateSheet,
  type FaqdefSheet,
  type FaqdefSheetEntry,
} from "./sheet.js";
import { writeTextAtomically, writeJsonAtomically } from "../demodrive/output.js";

const FAQDEF_CONFIG_SCHEMA_PATH = join("contracts", "faqdef-config.schema.json");
const TEMPLATE_PATH = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "templates",
  "question-generation.template.md",
);
const FALLBACK_PATH = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "templates",
  "fallback-checklist.md",
);

export const AXES = [
  "presentation",
  "business_value",
  "application_of_technology",
  "originality",
] as const;

export interface FaqdefConfig {
  version: "1.0.0";
  question_count: number;
  axes: readonly string[];
  include_sponsor_tracks: boolean;
}

export const FAQDEF_CONFIG_DEFAULTS: FaqdefConfig = {
  version: "1.0.0",
  question_count: 18,
  axes: AXES,
  include_sponsor_tracks: true,
};

//#region Config resolution (§8.2 — file + env overrides, safe defaults)

/** config/faqdef.json via RES-04; malformed → warn + defaults (never crash);
 * env overrides FAQDEF_QUESTION_COUNT / FAQDEF_BUDGET_S win mid-event. */
export function loadFaqdefConfig(configPath?: string): FaqdefConfig & { budget_s?: number } {
  let cfg: FaqdefConfig = { ...FAQDEF_CONFIG_DEFAULTS };

  const path = configPath ?? join("config", "faqdef.json");
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const schema = JSON.parse(readFileSync(FAQDEF_CONFIG_SCHEMA_PATH, "utf8")) as object;
      const res = validate(schema, parsed);
      if (!res.valid) {
        const qErr =
          res.errors.find((e) => e.path.includes("question_count")) ?? res.errors[0]!;
        console.warn(
          `warn: faqdef config invalid at ${qErr.path}: ${qErr.message}, using default 18`,
        );
      } else {
        const raw = parsed as Record<string, unknown>;
        cfg = {
          version: "1.0.0",
          question_count:
            typeof raw["question_count"] === "number" ? raw["question_count"] : 18,
          axes: AXES,
          include_sponsor_tracks: raw["include_sponsor_tracks"] !== false,
        };
      }
    } catch (err) {
      console.warn(
        `warn: faqdef config unreadable at ${path} (${err instanceof Error ? err.message : String(err)}), using defaults`,
      );
    }
  }

  // Post-validator clamp 5..30 (FAQDEF-01).
  if (cfg.question_count < 5) cfg.question_count = 5;
  if (cfg.question_count > 30) cfg.question_count = 30;

  // Operator fast overrides (mid-event tweak without file edit).
  const envCount = process.env["FAQDEF_QUESTION_COUNT"];
  if (envCount && /^\d+$/.test(envCount)) {
    const n = Number.parseInt(envCount, 10);
    if (n >= 5 && n <= 30) cfg.question_count = n;
    else console.warn(`warn: FAQDEF_QUESTION_COUNT=${envCount} outside 5..30 — ignored`);
  }
  let budget_s: number | undefined;
  const envBudget = process.env["FAQDEF_BUDGET_S"];
  if (envBudget && /^\d+$/.test(envBudget)) budget_s = Number.parseInt(envBudget, 10);

  return { ...cfg, budget_s };
}

//#endregion

//#region Input readers (plan / manifest / PROV / sponsors — FAQDEF-02)

export interface FaqdefInputs {
  planText: string;
  manifestComponentIds: string[];
  architectureSummary: string;
  disclosureText: string;
  sponsorTracks: string[]; // kebab-case slugs; empty = 4 axes only
}

const FROZEN_HEADINGS = [
  "## Executive Pitch",
  "## Problem Framing",
  "## Target Persona",
  "## Why Now",
  "## Business Value",
  "## Architecture",
  "## Risks & Open Questions",
  "## Ask & Next Steps",
];

/** Plan excerpts = frontmatter + frozen body headings (DP-K §7.2). */
export function extractPlanExcerpts(planText: string): string {
  if (!planText) return "(winning_project_plan.md not provided)";
  const parts: string[] = [];
  const fm = /^---\n([\s\S]*?)\n---/.exec(planText);
  if (fm?.[1]) parts.push(fm[1].trim());
  for (const heading of FROZEN_HEADINGS) {
    const idx = planText.indexOf(heading);
    if (idx === -1) continue;
    const next = FROZEN_HEADINGS.map((h) => planText.indexOf(h, idx + 1)).find((i) => i > idx);
    const section = planText.slice(idx, next ?? undefined).trim();
    parts.push(section.slice(0, 2400)); // keep prompt bounded
  }
  return parts.join("\n\n");
}

/** Track names → kebab-case slugs for sheet tags. */
export function toSponsorSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Sponsor tracks: event_profile.json tracks.sponsors[] first, then plan
 * frontmatter sponsor_tracks; neither → [] and generation proceeds on the
 * 4 axes alone (PROFILE-05 graceful degradation). */
export function collectSponsorTracks(args: { profilePath?: string; planText: string }): string[] {
  const tracks: string[] = [];
  if (args.profilePath && existsSync(args.profilePath)) {
    try {
      const profile = JSON.parse(readFileSync(args.profilePath, "utf8")) as {
        tracks?: { sponsors?: unknown };
      };
      for (const s of (profile.tracks?.sponsors ?? []) as unknown[]) {
        if (typeof s === "string") tracks.push(toSponsorSlug(s));
        else if (s && typeof s === "object") {
          const name = (s as { name?: unknown }).name;
          if (typeof name === "string") tracks.push(toSponsorSlug(name));
        }
      }
    } catch {
      console.warn(`warn: event profile unreadable at ${args.profilePath} — falling back to plan frontmatter (PROFILE-05)`);
    }
  }
  if (tracks.length === 0 && args.planText) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(args.planText);
    const m = fm?.[1]?.match(/^sponsor_tracks:\s*\[([^\]]*)\]/m);
    if (m) {
      for (const raw of m[1]!.split(",")) {
        const name = raw.trim().replace(/^['"]|['"]$/g, "");
        if (name) tracks.push(toSponsorSlug(name));
      }
    }
  }
  return [...new Set(tracks)];
}

//#endregion

//#region Prompt rendering + coverage (FAQDEF-01/02)

/** Render the generic §5.3 template. architectureSummary enters VERBATIM —
 * reuse, never re-derive (FAQDEF-02). */
export function renderGenerationPrompt(template: string, args: {
  questionCount: number;
  planExcerpts: string;
  manifestComponentIds: string[];
  architectureSummary: string;
  sponsorTracks: string[];
}): string {
  const subs: Record<string, string> = {
    question_count: String(args.questionCount),
    architecture_summary: args.architectureSummary || "(architecture-summary.md absent)",
    manifest_components:
      args.manifestComponentIds.length > 0
        ? args.manifestComponentIds.map((id) => `- ${id}`).join("\n")
        : "(assembly.manifest.json not provided)",
    plan_excerpts: args.planExcerpts,
    sponsor_tracks:
      args.sponsorTracks.length > 0 ? args.sponsorTracks.join(", ") : "(none — 4 axes only)",
  };
  let out = template;
  for (const [key, value] of Object.entries(subs)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), value);
  }
  return out;
}

/** Axis coverage: each of the 4 axes ≥2 questions among the sheet; when an axis
 * is under-covered, retag a sponsor-tagged question from an over-covered axis
 * with a single warn (DP-D2b §5.2 rebalance). Mutates a copy; never drops tags. */
export function enforceAxisCoverage(entries: FaqdefSheetEntry[]): { entries: FaqdefSheetEntry[]; rebalanced: boolean } {
  const count = (axis: string): number =>
    entries.filter((e) => e.tags.includes(axis)).length;
  let rebalanced = false;
  for (const axis of AXES) {
    while (count(axis) < 2) {
      const donor = entries.find(
        (e) =>
          e.tags.some((t) => !AXES.includes(t as never)) && // carries a sponsor slug
          e.tags.filter((t) => AXES.includes(t as never)).some((a) => count(a) > 2),
      );
      if (!donor) break;
      const donorAxis = donor.tags.find((t) => AXES.includes(t as never) && count(t) > 2);
      if (!donorAxis) break;
      donor.tags = [...donor.tags.filter((t) => t !== donorAxis), axis];
      rebalanced = true;
      console.warn(`warn: axis under-coverage — retagged ${donor.id} ${donorAxis} → ${axis} to satisfy 2-per-axis floor`);
    }
  }
  return { entries, rebalanced };
}

//#endregion

//#region Main pipeline

export interface GenerateOptions {
  planPath?: string;
  manifestPath?: string;
  disclosurePath?: string;
  profilePath?: string;
  configPath?: string;
  outDir?: string;
  /** Injected LLM callable (tests/offline). Default: provider call via llm.ts. */
  callLlm?: FaqdefLlm;
}

function readIfPresent(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Parse + RES-04-validate the model's JSON output into a FaqdefSheet shape. */
export function parseModelSheet(raw: string): { ok: true; questions: FaqdefSheetEntry[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // tolerate fenced JSON blocks
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    if (!m?.[1]) return { ok: false, error: "model output was not valid JSON" };
    try {
      parsed = JSON.parse(m[1]!) as unknown;
    } catch (err) {
      return { ok: false, error: `model output was not valid JSON (${String(err)})` };
    }
  }
  const obj = parsed as { questions?: unknown };
  if (!obj || !Array.isArray(obj.questions)) {
    return { ok: false, error: "model output missing questions[]" };
  }
  return { ok: true, questions: obj.questions as FaqdefSheetEntry[] };
}

export interface GenerateResult {
  ok: boolean;
  mode: "generated" | "fallback";
  outFiles: string[];
  message?: string;
}

export async function generateFaqdefSheet(opts: GenerateOptions): Promise<GenerateResult> {
  const cfg = loadFaqdefConfig(opts.configPath);
  const planText = readIfPresent(opts.planPath);
  const manifestRaw = readIfPresent(opts.manifestPath);
  const disclosureText = readIfPresent(opts.disclosurePath);
  // PROV-05 summary is consumed VERBATIM (reuse-not-re-derive); .txt alias tolerated.
  let architectureSummary = "";
  if (opts.disclosurePath) {
    const baseDir = opts.disclosurePath.replace(/[\\/][^\\/]*$/, "");
    architectureSummary = readIfPresent(join(baseDir, "architecture-summary.md"));
  }

  let manifestComponentIds: string[] = [];
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(manifestRaw) as {
        components?: Array<{ id?: string; included?: boolean }>;
        chassis_version?: string;
      };
      manifestComponentIds = (manifest.components ?? [])
        .filter((c) => c.included !== false && typeof c.id === "string")
        .map((c) => c.id as string);
    } catch {
      console.warn(`warn: assembly manifest unreadable at ${opts.manifestPath} — proceeding without component ids`);
    }
  }

  const sponsorTracks = cfg.include_sponsor_tracks
    ? collectSponsorTracks({ profilePath: opts.profilePath, planText })
    : [];
  const planExcerpts = extractPlanExcerpts(planText);

  const outDir = opts.outDir ?? join("docs", "qa");
  const template = readIfPresent(TEMPLATE_PATH) || "Produce {{question_count}} judge questions grounded in:\n{{plan_excerpts}}\n{{manifest_components}}\n{{architecture_summary}}\n{{sponsor_tracks}}";

  const prompt = renderGenerationPrompt(template, {
    questionCount: cfg.question_count,
    planExcerpts,
    manifestComponentIds,
    architectureSummary,
    sponsorTracks,
  });

  // ---- RES-01-wrapped generation ------------------------------------------
  const callLlm = opts.callLlm ?? ((input: string) => defaultCallLlm("faqdef_generator", input));
  const wrapped = resilientFaqdefCall(callLlm, prompt);
  const result = await wrapped();

  if (
    typeof result !== "string" ||
    ((result as unknown as DegradedResult<string>).degraded === true)
  ) {
    // FAQDEF-RES-01 fallback — static checklist, exit 0, never crash/empty.
    const fallbackTemplate = readIfPresent(FALLBACK_PATH);
    const fallbackBody = fallbackTemplate || "# Fallback Checklist\n\nLLM unavailable."
    const target = join(outDir, "qa-sheet.fallback.md");
    writeTextAtomically(target, expandFallback(fallbackBody, manifestComponentIds, sponsorTracks));
    console.warn("warn: question generation via RES-01 exhausted — wrote fallback checklist (FAQDEF-RES-01).");
    return { ok: true, mode: "fallback", outFiles: [target] };
  }

  const parsedModel = parseModelSheet(result);
  if (!parsedModel.ok) {
    console.warn(`warn: model output rejected (${parsedModel.error}) — writing fallback checklist (FAQDEF-RES-01).`);
    const fallbackTemplate = readIfPresent(FALLBACK_PATH);
    const target = join(outDir, "qa-sheet.fallback.md");
    writeTextAtomically(target, expandFallback(fallbackTemplate || "# Fallback Checklist", manifestComponentIds, sponsorTracks));
    return { ok: true, mode: "fallback", outFiles: [target], message: parsedModel.error };
  }

  // ---- Post-processing: grounding → coverage → clamp → validate -----------
  let entries = parsedModel.questions.slice(0, 30); // clamp high
  while (entries.length < 5) {
    // clamp low with an explicit gap entry so the sheet is never empty/thin
    entries.push({
      id: `q-${String(entries.length + 1).padStart(2, "0")}`,
      question: "Placeholder — regenerate with a higher question budget.",
      tags: ["presentation"],
      draft_answer: "Not stated in winning_project_plan.md / manifest / PROV disclosure — verify before citing.",
      citations: ["not_stated"],
      source_grounding: "not_stated",
    });
  }
  entries = entries.map((e, i) => ({ ...e, id: e.id ?? `q-${String(i + 1).padStart(2, "0")}` }));

  const grounded = validateGrounding(entries, {
    planText,
    manifestComponentIds,
    disclosureText,
  });
  enforceAxisCoverage(grounded.entries);

  const sheet: FaqdefSheet = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    question_count: grounded.entries.length,
    questions: grounded.entries,
  };

  const check = validateSheet(sheet);
  if (!check.valid) {
    return {
      ok: false,
      mode: "fallback",
      outFiles: [],
      message: `generated sheet failed RES-04 validation: ${check.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
    };
  }

  const jsonPath = join(outDir, "qa-sheet.json");
  const mdPath = join(outDir, "qa-sheet.md");
  writeJsonAtomically(jsonPath, sheet);
  writeTextAtomically(mdPath, renderSheetMarkdown(sheet));
  return { ok: true, mode: "generated", outFiles: [jsonPath, mdPath] };
}

/** Fill the static checklist placeholders with whatever inputs exist. */
function expandFallback(template: string, manifestComponentIds: string[], sponsorTracks: string[]): string {
  return template
    .replace(/<expanded from manifest when available, else: See assembly\.manifest\.json:components>/, manifestComponentIds.join(", ") || "See assembly.manifest.json:components")
    .replace(/<sponsors or: See event_profile\.json:tracks>/, sponsorTracks.join(", ") || "See event_profile.json:tracks");
}

//#endregion
