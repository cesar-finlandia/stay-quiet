// Requirement IDs: SCRIPT-01, SCRIPT-REU-02, PROFILE-05, RES-04, GOV-RES-02,
// XCUT-08 — DP-D2a §4.1/§6.6/§7.
//
// timing.yaml (alias timing.json) → validated TimingConfig + cumulative mm:ss
// windows. Section boundaries and total target length are CONFIGURATION, never
// hardcoded (SCRIPT-REU-02): adding a 5th section is a config-only change.
//
// Error semantics differ from other configs on purpose (§6.6): timing.yaml is
// human-authored and wrong timestamps would violate SCRIPT-AC-01, so a malformed
// or sum-mismatched file is a hard TimingValidationError that the CLI maps to
// exit 1 ("ERROR: timing.yaml invalid at <path>: <message>. Fix sum == total.")
// instead of the warn+safe-default degradation used elsewhere.
//
// No yaml npm dependency exists in this repo, so parseTimingYaml implements the
// small documented subset of the timing file shape (top-level scalars plus a
// sections list of flow mappings `- { k: v, ... }` and their block-style
// equivalent). Anything it cannot understand fails validation loudly rather
// than being silently skipped.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../resilience/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");

/** En-dash separator used between mm:ss window bounds, exactly as in §4.1. */
export const WINDOW_SEPARATOR = "–";

//#region Types (shape mirrors contracts/script-timing.schema.json — $ref, never re-defined)

/** One ordered script section; minutes is 0.1..10 per the contract. */
export interface TimingSection {
  id: string;
  title: string;
  minutes: number;
  live?: boolean;
  description?: string;
}

/** Validated timing config. total_minutes may be null → derive downstream. */
export interface TimingConfig {
  version: "1.0.0";
  total_minutes: number | null;
  sections: TimingSection[];
}

/** Cumulative mm:ss window for one section, e.g. start "00:00", end "00:30". */
export interface TimingWindow {
  id: string;
  title: string;
  minutes: number;
  live: boolean;
  /** Section start as mm:ss (e.g. "00:30"). */
  start: string;
  /** Section end == next start; last end equals the total (e.g. "03:00"). */
  end: string;
  /** Display form `${start}${WINDOW_SEPARATOR}${end}` (e.g. "00:00–00:30"). */
  window: string;
}

/** SCRIPT signal: timing rejected pre-generation — CLI maps to exit 1 (§6.6). */
export class TimingValidationError extends Error {
  readonly path: string;
  readonly errors: Array<{ path: string; message: string; code: string }>;

  constructor(message: string, timingPath: string, errors: Array<{ path: string; message: string; code: string }>) {
    super(message);
    this.name = "TimingValidationError";
    this.path = timingPath;
    this.errors = errors;
  }
}

//#endregion

//#region Minimal YAML-subset parser for the documented timing file shape

/** Parse a scalar token: quoted string, null/true/false, or number; else raw string. */
function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return null;
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    return t.slice(1, -1);
  }
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

/** Strip a trailing comment that is outside of any quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split a flow-mapping body `{ k: v, k2: "v,2" }` on top-level commas. */
function splitFlowEntries(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (const ch of body) {
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (!inSingle && !inDouble) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Parse `k: v, k2: "v2"` pairs into an object. */
function parseFlowMapping(body: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const entry of splitFlowEntries(body)) {
    const idx = entry.indexOf(":");
    if (idx <= 0) throw new Error(`flow mapping entry is not key: value — "${entry.trim()}"`);
    const key = entry.slice(0, idx).trim();
    obj[key] = parseScalar(entry.slice(idx + 1));
  }
  return obj;
}

interface YamlListItem {
  /** First `- key: value` line's parsed pair (block style), if any. */
  first?: [string, unknown];
  /** Parsed object for `- { ... }` flow style. */
  flow?: Record<string, unknown>;
  /** Subsequent `key: value` continuation lines (block style). */
  rest: Array<[string, unknown]>;
}

/**
 * Parse the small YAML subset used by timing files: top-level `key: value`
 * scalars plus a `sections:` list whose items are either flow mappings
 * (`- { id: problem, minutes: <float> }`) or block-style entries (`- id: problem`
 * followed by more-indented `key: value` lines). Anything else throws so the
 * failure surfaces as a loud validation error instead of silent data loss.
 */
export function parseTimingYaml(text: string): unknown {
  const lines = text.split(/\r?\n/).map(stripComment);
  const doc: Record<string, unknown> = {};
  const items: YamlListItem[] = [];
  let listKey: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\t/g, "  ");
    if (!line.trim()) continue;

    const listMatch = /^(\s*)-\s+(.*)$/.exec(line);
    if (listMatch && listKey !== null) {
      items.push(parseListLine(listMatch[2] ?? ""));
      continue;
    }
    if (listMatch && listKey === null) {
      throw new Error(`list item at line ${i + 1} appears before any list key`);
    }

    const kv = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`cannot parse line ${i + 1}: "${line.trim()}"`);
    const [, indent, key, restRaw] = kv as unknown as [string, string, string, string];
    if (indent.length > 0) {
      // Continuation of the most recent block-style list item.
      const last = items[items.length - 1];
      if (!last || last.flow) throw new Error(`unexpected indented key "${key}" at line ${i + 1}`);
      last.rest.push([key, parseScalar(restRaw)]);
      continue;
    }
    if (restRaw.trim() === "") {
      // Block list header, e.g. `sections:`.
      listKey = key;
      continue;
    }
    doc[key] = parseScalar(restRaw);
  }

  if (listKey !== null) {
    doc[listKey] = items.map(materializeItem);
  }
  return doc;
}

function parseListLine(rest: string): YamlListItem {
  const flowMatch = /^\{(.*)\}$/.exec(rest.trim());
  if (flowMatch) return { flow: parseFlowMapping(flowMatch[1] ?? ""), rest: [] };
  const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
  if (!kv) throw new Error(`cannot parse list item entry: "${rest.trim()}"`);
  return { first: [kv[1] ?? "", parseScalar(kv[2] ?? "")], rest: [] };
}

function materializeItem(item: YamlListItem): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (item.flow) return item.flow;
  if (item.first) obj[item.first[0]] = item.first[1];
  for (const [k, v] of item.rest) obj[k] = v;
  return obj;
}

//#endregion

//#region RES-04 validation + arithmetic rules (§4.1)

let timingSchemaCache: object | null = null;

/** contracts/script-timing.schema.json — owned here (M13); consumers $ref it. */
export function loadTimingSchema(): object {
  return (timingSchemaCache ??= JSON.parse(
    readFileSync(join(REPO_ROOT, "contracts", "script-timing.schema.json"), "utf8"),
  ) as object);
}

/** Round to one decimal (the convention for minutes values). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Sum of section minutes rounded to one decimal. */
export function sumSectionMinutes(sections: TimingSection[]): number {
  return round1(sections.reduce((s, sec) => s + sec.minutes, 0));
}

function collectSchemaErrors(result: { valid: boolean; errors: Array<{ path: string; message: string; code: string }> }):
    Array<{ path: string; message: string; code: string }> {
  return result.errors.map((e) => ({ path: e.path, message: e.message, code: e.code }));
}

/**
 * Validate a parsed timing document: RES-04 against
 * contracts/script-timing.schema.json plus the arithmetic rule the schema
 * cannot express — when total_minutes is non-null it must equal
 * sum(sections[].minutes) within ±0.01 after rounding to one decimal.
 * Throws TimingValidationError on any failure (CLI maps to exit 1, §6.6).
 */
export function validateTiming(doc: unknown, timingPath: string): TimingConfig {
  const result = validate(loadTimingSchema(), doc);
  if (!result.valid || typeof doc !== "object" || doc === null) {
    const first = result.errors[0];
    throw new TimingValidationError(
      first ? `${first.path}: ${first.message}` : "failed RES-04 validation",
      timingPath,
      collectSchemaErrors(result),
    );
  }
  const cfg = doc as unknown as TimingConfig;
  if (cfg.total_minutes != null) {
    const sum = sumSectionMinutes(cfg.sections);
    if (Math.abs(sum - cfg.total_minutes) > 0.01) {
      throw new TimingValidationError(
        `timing validation: sum ${sum.toFixed(1)} != total ${Number(cfg.total_minutes).toFixed(1)} — adjust sections to sum to total`,
        timingPath,
        [{ path: "/total_minutes", message: `sum ${sum.toFixed(1)} != total ${cfg.total_minutes}`, code: "sum-mismatch" }],
      );
    }
  }
  return cfg;
}

/**
 * loadTiming(path|null) — read + parse + validate a timing config.
 *
 * - null/undefined → null (caller derives the total from profile/fallback).
 * - `.json` files (or the timing.json alias) are parsed as JSON; everything
 *   else goes through the YAML subset parser.
 * - Any read/parse/validation failure throws TimingValidationError carrying the
 *   exact file path — §6.6 exit-1 semantics because wrong timestamps would
 *   violate SCRIPT-AC-01 (deliberately NOT warn+default like other configs).
 */
export function loadTiming(path: string | null | undefined): TimingConfig | null {
  if (path == null || !path.trim()) return null;
  const resolved = path.trim();
  try {
    const text = readFileSync(resolved, "utf8");
    const parsed = /\.json$/i.test(resolved) ? JSON.parse(text) : parseTimingYaml(text);
    return validateTiming(parsed, resolved);
  } catch (err) {
    if (err instanceof TimingValidationError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new TimingValidationError(msg, resolved, [{ path: "/", message: msg, code: "read-or-parse" }]);
  }
}

//#endregion

//#region Cumulative mm:ss window math (SCRIPT-AC-01)

/** Format whole seconds as mm:ss (minutes zero-padded to 2 digits). */
export function formatMMSS(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * computeWindows(timing) — cumulative mm:ss windows per section.
 *
 * Boundaries are the cumulative sum of section minutes (float minutes ×60,
 * rounded to whole seconds at each boundary — one-decimal-minute inputs land
 * exactly); the last window always ends at the total (e.g. "03:00"). Bounds
 * are joined with the en-dash in `window` exactly as in the §4.1 examples.
 * Adding/reordering sections changes the output with zero code changes
 * (SCRIPT-REU-02) — no hardcoded minutes or titles anywhere below.
 */
export function computeWindows(timing: TimingConfig): TimingWindow[] {
  // Cumulative minute boundaries; boundary i is where section i ends.
  const boundaries: number[] = [0];
  let acc = 0;
  for (const sec of timing.sections) {
    acc += sec.minutes;
    boundaries.push(acc);
  }
  return timing.sections.map((sec, i) => {
    // boundaries has length sections.length + 1, so these indices are always
    // in range; ?? guards only satisfy noUncheckedIndexedAccess.
    const startMin = boundaries[i] ?? 0;
    const endMin = boundaries[i + 1] ?? acc;
    const startS = formatMMSS(startMin * 60);
    const endS = formatMMSS(endMin * 60);
    return {
      id: sec.id,
      title: sec.title,
      minutes: sec.minutes,
      live: sec.live === true,
      start: startS,
      end: endS,
      window: `${startS}${WINDOW_SEPARATOR}${endS}`,
    };
  });
}

//#endregion
