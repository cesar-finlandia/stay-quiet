// Requirement IDs: SCRIPT-04, DECKGEN-01, GOV-RES-01, XCUT-08 — DP-D2a §4.4/§9.5.
//
// Business Value allow-list extraction + never-fabrication audit.
//
// - extractBusinessValue(planText) parses the frozen contract-#7 headings with
//   regex ONLY (never an LLM — fact selection stays mechanical): the
//   `## Business Value` bullets specific_user / tam_figure / revenue_model /
//   why_ai, plus the `## Why Now` one-liner. Absent fields are null; nothing is
//   invented (SCRIPT-04).
// - auditSpokenBusinessValue(spoken, allow) implements the §4.4 audit verbatim:
//   every numeric token in a Business Value spoken paragraph must be a verbatim
//   substring of tam_figure or revenue_model; the first stray token returns
//   {ok:false, invented}. generate.ts rewrites the spoken block to the exact
//   TODO literal and warns on failure — an invented claim can never ship.

/** The only nouns-numbers a Business Value spoken paragraph may contain (§4.4). */
export interface AllowList {
  specific_user: string | null;
  tam_figure: string | null;
  revenue_model: string | null;
  why_ai: string | null;
  why_now: string | null;
}

export type EmptyAllowList = AllowList;

/** All-null allow-list (plan silent on Business Value → TODO spoken block). */
export function emptyAllowList(): AllowList {
  return { specific_user: null, tam_figure: null, revenue_model: null, why_ai: null, why_now: null };
}

/** True when every field is absent (plan entirely silent on Business Value). */
export function isSilent(allow: AllowList): boolean {
  return (
    allow.specific_user === null &&
    allow.tam_figure === null &&
    allow.revenue_model === null &&
    allow.why_ai === null &&
    allow.why_now === null
  );
}

//#region heading/body extraction (regex + heading parse ONLY)

/**
 * Body of one frozen `## <name>` section (to the next `##` heading or EOF),
 * or null when absent. Frontmatter is ignored here by construction.
 */
export function extractHeadingBody(planText: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##[ \\t]+${escaped}[ \\t]*#*[ \\t]*$`, "im");
  const m = re.exec(planText);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const rest = planText.slice(start);
  const next = /^##[ \t]/im.exec(rest);
  const body = next && next.index !== undefined ? rest.slice(0, next.index) : rest;
  return body.trim() === "" ? null : body.trim();
}

/** First non-empty sentence of a body (period/./!/… terminated) else whole first line. */
export function firstSentence(body: string | null): string | null {
  if (!body) return null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^.*?[.!](?:\s|$)/.exec(line);
    return (m ? m[0] : line).trim();
  }
  return null;
}

//#endregion

//#region allow-list extraction (§4.4 table)

const BV_FIELDS = ["specific_user", "tam_figure", "revenue_model", "why_ai"] as const;

/**
 * extractBusinessValue(planText) — regex/heading parse ONLY (never LLM).
 *
 * Precedence per field mirrors DP-D2a §4.4:
 * - specific_user: `## Business Value` bullet → `## Target Persona` first
 *   sentence (fallback).
 * - tam_figure / revenue_model / why_ai: `## Business Value` bullets only.
 * - why_now: `## Why Now` first non-empty line.
 * Absent everywhere → null (caller renders the silent-plan TODO row).
 */
export function extractBusinessValue(planText: string): AllowList {
  const allow = emptyAllowList();

  const bvBody = extractHeadingBody(planText, "Business Value");
  if (bvBody !== null) {
    for (const rawLine of bvBody.split(/\r?\n/)) {
      const m = /^\s*[-*]\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/.exec(rawLine);
      if (!m) continue;
      const key = m[1] ?? "";
      const value = (m[2] ?? "").trim();
      if (!(BV_FIELDS as readonly string[]).includes(key)) continue;
      if (value === "") continue;
      allow[key as (typeof BV_FIELDS)[number]] = value;
    }
  }

  // specific_user fallback chain: Target Persona first sentence.
  if (allow.specific_user === null) {
    allow.specific_user = firstSentence(extractHeadingBody(planText, "Target Persona"));
  }

  // why_now one-liner from `## Why Now`.
  const whyNowBody = extractHeadingBody(planText, "Why Now");
  allow.why_now = whyNowBody ? (whyNowBody.split(/\r?\n/).find((l) => l.trim()) ?? null)?.trim() ?? null : null;

  return allow;
}

//#endregion

//#region never-fabrication audit (§4.4 code, implemented verbatim in spirit)

/** Numeric-token pattern from the plan: `$12B`, `8%`, `1,500`, `3.5M`, `2026`… */
const NUMERIC_TOKEN_RE = /\$?[\d.,]+\s*[%BKMb]*/g;

/** Trim punctuation-only edges so tokens like "." or "," don't false-positive. */
function normalizeToken(token: string): string {
  return token.replace(/^[\s.,$]+/, "").replace(/[\s.,]+$/, "");
}

export interface AuditResult {
  ok: boolean;
  /** First numeric token not present in tam_figure/revenue_model (when !ok). */
  invented?: string;
}

/**
 * auditSpokenBusinessValue(spoken, allow) — every numeric token must appear
 * verbatim inside tam_figure or revenue_model; otherwise {ok:false, invented}.
 * Non-Business-Value callers may pass any paragraph; empty/null spoken is ok.
 */
export function auditSpokenBusinessValue(spoken: string, allow: AllowList): AuditResult {
  if (!spoken) return { ok: true };
  const tokens = spoken.match(NUMERIC_TOKEN_RE) ?? [];
  for (const raw of tokens) {
    const token = normalizeToken(raw);
    if (token === "" || !/\d/.test(token)) continue; // punctuation-only remnant
    const inTam = allow.tam_figure != null && allow.tam_figure.includes(token);
    const inRevenue = allow.revenue_model != null && allow.revenue_model.includes(token);
    if (!inTam && !inRevenue) return { ok: false, invented: token };
  }
  return { ok: true };
}

//#endregion

//#region TODO literals (§4.4 — exact rendered forms)

/** Audit-failure rewrite literal (Business Value spoken block). */
export const BV_AUDIT_TODO =
  "> **TODO:** Business Value spoken text — numeric claim not found in winning_project_plan.md §## Business Value — revise plan and re-run script generate.";

/** Silent-plan table-row literal (no Business Value content at all). */
export const BV_SILENT_TODO =
  "> **TODO:** Business Value — no tam_figure / revenue_model in winning_project_plan.md — populate Business Value then re-run.";

//#endregion
