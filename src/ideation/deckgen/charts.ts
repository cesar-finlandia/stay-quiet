// Requirement IDs: DECKGEN-04, DECKGEN-01, DECKGEN-REU-02, GOV-MIN-04, XCUT-08
// Business Value figures → vector SVG charts — DP-D2a §3.5 (decision 6.13:
// SVG canonical, Mermaid pie additive alt). Pure deterministic string templates,
// RES-01-free (no LLM anywhere): every label and number is copied verbatim from
// `winning_project_plan.md ## Business Value`; a missing figure means NO chart —
// the caller emits a `> **TODO:**` marker instead (never a placeholder number).
// Zero chart dependency (GOV-MIN-04): the generators interpolate plain `<svg>`
// strings using the PIT-02 theme.json palette (overridable via the
// config/deckgen.json `chart.palette` knob, contracts/deckgen-config.schema.json).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Fields parsed from `## Business Value` — both null when the heading is absent. */
export interface BusinessValueFigures {
  tam_figure: string | null;
  revenue_model: string | null;
}

/**
 * Chart colors default to the PIT-02 single-source theme tokens
 * (templates/pitch-deck/theme.css: accent #6AE3FF, accent2 #FF6A88,
 * muted #8A8F98, fg #F2F2F2, bg #0F1115). A caller loading
 * config/deckgen.json may pass any subset via `chart.palette`.
 */
export interface ChartPalette {
  /** Primary stroke/bar color (PIT-02 color_accent). */
  bar: string;
  /** Background track behind the TAM bar. */
  track: string;
  /** Heading/figure text color (PIT-02 color_fg). */
  text: string;
  /** Source-line color (PIT-02 color_muted). */
  muted: string;
  /** Text drawn on top of revenue slice rects. */
  onSlice: string;
  /** Cycled across revenue slices/tags (accent, accent2, muted). */
  slices: string[];
}

export const DEFAULT_CHART_PALETTE: ChartPalette = {
  bar: "#6AE3FF",
  track: "#8A8F98",
  text: "#F2F2F2",
  muted: "#8A8F98",
  onSlice: "#0F1115",
  slices: ["#6AE3FF", "#FF6A88", "#8A8F98"],
};

function resolvePalette(override?: Partial<ChartPalette>): ChartPalette {
  return { ...DEFAULT_CHART_PALETTE, ...(override ?? {}) };
}

/** Escape raw plan text for safe interpolation into SVG/XML text nodes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * extractBusinessValueFigures — forgiving heading+field parse (§3.5 "Parsing
 * (forgiving, never fail)"). Finds the `## Business Value` section, then reads
 * its `tam_figure:` / `revenue_model:` bullet fields. Never throws; unknown or
 * missing fields come back as null so callers can emit TODO markers instead.
 */
export function extractBusinessValueFigures(planText: string): BusinessValueFigures {
  const empty: BusinessValueFigures = { tam_figure: null, revenue_model: null };
  if (!planText) return empty;

  // Section = text between the Business Value heading and the next same-or-
  // higher-level heading (or EOF). Tolerant of ATX depth and trailing #s.
  const heading = planText.match(/^#{1,6}[ \t]+business[ \t]+value[ \t]*#*[ \t]*$/im);
  if (!heading || heading.index === undefined) return empty;
  const bodyStart = heading.index + heading[0].length;
  const nextHeading = planText.slice(bodyStart).match(/^#{1,6}[ \t]+\S/im);
  const section =
    nextHeading && nextHeading.index !== undefined
      ? planText.slice(bodyStart, bodyStart + nextHeading.index)
      : planText.slice(bodyStart);

  // Field line: `- key: value` (dash optional, key case-insensitive).
  const readField = (key: string): string | null => {
    const m = section.match(new RegExp(`^[-* \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, "im"));
    const value = m?.[1]?.trim();
    return value ? value : null;
  };

  return {
    tam_figure: readField("tam_figure"),
    revenue_model: readField("revenue_model"),
  };
}

/**
 * Parse the primary amount out of a raw TAM figure string, e.g.
 * "$12B total addressable market" → 12e9. Uses the §3.5 regex `$?[\d.,]+\s*[KMB]?`
 * plus optional `billion|million|trillion|TAM` tokens; the FIRST number is
 * primary (rest are subtitle material). Returns null when no digit-bearing
 * token exists — the caller then omits the chart entirely (never invents).
 */
export function parseTamAmount(tamFigure: string): number | null {
  const m = tamFigure.match(/\$?[\d.,]+\s*[KMBkmb]?/);
  if (!m || !/\d/.test(m[0])) return null;
  const token = m[0].trim();
  const numeric = parseFloat(token.replace(/[$,]/g, ""));
  if (!Number.isFinite(numeric)) return null;

  // Magnitude suffix — attached K/M/B token or a spelled-out word nearby.
  let magnitude = 1;
  if (/[Bb]\s*$/.test(token) || /\bbillion\b/i.test(tamFigure)) magnitude = 1e9;
  else if (/[Mm]\s*$/.test(token) || /\bmillion\b/i.test(tamFigure)) magnitude = 1e6;
  else if (/[Kk]\s*$/.test(token)) magnitude = 1e3;
  else if (/\btrillion\b/i.test(tamFigure)) magnitude = 1e12;

  const amount = numeric * magnitude;
  return amount > 0 ? amount : null;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * bar_width per §3.5: `width = 48 + 512 * sigmoid(log10(amount)/12)`, clamped
 * to 48..560 — so $12B renders longer than $12M without an axis, never zero.
 */
export function tamBarWidth(amount: number): number {
  const width = Math.round(48 + 512 * sigmoid(Math.log10(amount) / 12));
  return Math.min(560, Math.max(48, width));
}

/**
 * generateTamChart — chart-tam.svg per the §3.5 template: viewBox 600x120,
 * .bar over .track, raw figure text verbatim, literal source line. Returns
 * null when the figure carries no number — slot 06 then shows `> **TODO:**
 * Market size` instead (DECKGEN-01 never-fabrication).
 */
export function generateTamChart(
  tamFigure: string | null | undefined,
  paletteOverride?: Partial<ChartPalette>,
): string | null {
  const raw = typeof tamFigure === "string" ? tamFigure.trim() : "";
  if (!raw) return null;
  const amount = parseTamAmount(raw);
  if (amount === null) return null;

  const p = resolvePalette(paletteOverride);
  // First number primary; any further numbers ride along in the raw string
  // itself (§3.5: "the first is primary and the rest shown as subtitle") —
  // nothing beyond the verbatim figure is ever rendered.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 120" role="img">
  <style> text{font-family:Inter,system-ui; fill:${p.text}} .bar{fill:${p.bar}} .track{fill:${p.track}; opacity:.25}</style>
  <text x="12" y="22" font-size="13" font-weight="700">TAM — from winning_project_plan.md § Business Value</text>
  <rect x="12" y="40" width="576" height="22" rx="11" class="track"/>
  <rect x="12" y="40" width="${tamBarWidth(amount)}" height="22" rx="11" class="bar"/>
  <text x="12" y="88" font-size="16" font-weight="700">${esc(raw)}</text>
  <text x="12" y="108" font-size="11" fill="${p.muted}">Source: winning_project_plan.md — never invented</text>
</svg>
`;
}

/**
 * Split a revenue_model string into 2–4 display tags per §3.5: separators are
 * `+`, `/`, `&`, and the word `and`. A single token yields a one-tag array
 * (badge fallback). Never throws; empty text yields an empty array.
 */
export function splitRevenueTags(revenueModel: string): string[] {
  const parts = revenueModel
    .split(/\s*[+&/]\s*|\s+and\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (parts.length <= 4) return parts;
  // >4 tokens: keep the first three whole, fold the remainder into the fourth
  // so the §3.5 2–4 tag bound holds without dropping any stated stream.
  return [...parts.slice(0, 3), parts.slice(3).join(" + ")];
}

/** Stated percentage on a tag ("take-rate 8%" → 8), else null — never inferred. */
function statedPercent(tag: string): number | null {
  const m = tag.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1] ?? "") : null;
}

const REVENUE_SOURCE_LINE = "Source: winning_project_plan.md — never invented";

/**
 * generateRevenueChart — chart-revenue.svg per §3.5: a rect "slice" per split
 * tag (#6AE3FF/#FF6A88/#8A8F98 cycle, labels verbatim from the plan text — no
 * percentage is ever invented); a single-token model renders the labeled-badge
 * fallback. Returns null when the model text is absent/empty (TODO instead).
 */
export function generateRevenueChart(
  revenueModel: string | null | undefined,
  paletteOverride?: Partial<ChartPalette>,
): string | null {
  const raw = typeof revenueModel === "string" ? revenueModel.trim() : "";
  if (!raw) return null;
  const tags = splitRevenueTags(raw);
  if (tags.length === 0) return null;

  const p = resolvePalette(paletteOverride);
  const header = `  <text x="12" y="22" font-size="13" font-weight="700" fill="${p.text}">Revenue model — winning_project_plan.md</text>`;
  const source = `  <text x="12" y="140" font-size="11" fill="${p.muted}">${REVENUE_SOURCE_LINE}</text>`;

  let body: string;
  if (tags.length === 1) {
    // Fallback single tag = labeled badge (§3.5).
    body = `  <g id="badge">
    <rect x="12" y="42" width="576" height="72" rx="12" fill="${p.slices[0]}"/>
    <text x="32" y="86" font-size="15" font-weight="700" fill="${p.onSlice}">${esc(tags[0] ?? "")}</text>
  </g>`;
  } else {
    // One 280px-wide rect per tag laid out left→right, colors cycling.
    const rects = tags
      .map((tag, i) => {
        const x = 12 + i * 296;
        const color = p.slices[i % p.slices.length];
        return `    <rect x="${x}" y="42" width="280" height="72" rx="12" fill="${color}"/><text x="${x + 20}" y="86" font-size="15" font-weight="700" fill="${p.onSlice}">${esc(tag)}</text>`;
      })
      .join("\n");
    body = `  <g id="slices">\n${rects}\n  </g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160" role="img">
  <style> text{font-family:Inter,system-ui}</style>
${header}
${body}
${source}
</svg>
`;
}

/**
 * generateRevenueMermaidAlt — the additive Mermaid `pie` alternative written
 * alongside chart-revenue.svg (decision 6.13). Slice weights use ONLY
 * percentages literally stated in the plan text; when none/all are missing,
 * tags get an equal structural weight purely so Mermaid's pie syntax renders
 * (display-only weighting, not a claimed split). Returns null with the model
 * text absent — never fabricates content.
 */
export function generateRevenueMermaidAlt(
  revenueModel: string | null | undefined,
): string | null {
  const raw = typeof revenueModel === "string" ? revenueModel.trim() : "";
  if (!raw) return null;
  const tags = splitRevenueTags(raw);
  if (tags.length === 0) return null;

  const stated = tags.map(statedPercent);
  const allStated = stated.every((v) => v !== null);
  const weights = allStated
    ? (stated as number[])
    : tags.map(() => Math.round((100 / tags.length) * 100) / 100);

  const lines = tags.map((tag, i) => `  "${tag.replace(/"/g, "'")}" : ${weights[i]}`);
  return `pie title Revenue model — from winning_project_plan.md\n${lines.join("\n")}\n`;
}

/**
 * writeChartAtomic — tmp+rename emit of a chart SVG (GOV-RES-04, mirrors
 * writeDiagram in diagram.ts). Parent dirs created; no partial file visible.
 */
export function writeChartAtomic(outPath: string, svg: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, svg, "utf8");
  renameSync(tmp, outPath);
}
