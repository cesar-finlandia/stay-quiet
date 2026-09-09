#!/usr/bin/env node
// Requirement IDs: SCRIPT-01..05, SCRIPT-RES-01, SCRIPT-RES-02, GOV-RES-01,
// GOV-RES-02, GOV-RES-04, XCUT-08 — DP-D2a §6.6/§8.1 (CLI surface).
//
// script generate --plan <p> --manifest <m> --config <timing.yaml>
//                 [--event-profile event_profile.json] --out script.md [--validate]
// script validate --plan <p> --manifest <m> --config <timing.yaml>   (dry-run)
//
// Colon alias form for npm-script ergonomics: `script:generate ...` /
// `script:validate ...` — package.json registers the same cli.ts under both
// bin names; argv[0]'s basename is normalized so both spellings dispatch.
//
// Exit codes (§8.1/§6.6): 0 success — TODOs, missing plan, missing/invalid
// event profile and RES-01 blank-template fallback are warn-only; 1 blocking:
// timing.yaml invalid or sum mismatch ("Fix sum == total"), failed validation.
// Invalid manifest degrades visual cues to TODO but still writes headers (§6.6).
// Any unhandled throw maps to a DegradedResult-style log with an output file on
// disk (GOV-RES-04) — never a partial write.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadEventProfile } from "./defaultTotal.js";
import {
  generateScript,
  DEFAULT_TIMING_PATH,
  renderScriptStub,
  reconcileGeneratedAt,
  writeFileDiffAware,
  timingSourceLabel,
} from "./generate.js";
import { resolveTotalMinutes } from "./defaultTotal.js";
import { computeWindows, loadTiming, TimingValidationError } from "./timing.js";
import type { AssemblyManifestView } from "./validateVisuals.js";
import { validate } from "../../resilience/index.js";

export const USAGE = `usage:
  script generate --plan <file> --manifest <file> --config <timing.yaml>
                  [--event-profile <file>] --out <script.md> [--validate]
  script validate --plan <file> --manifest <file> --config <timing.yaml>
  script:generate|script:validate ...                     colon alias forms

Pitch video script & storyboard generator (DP-D2a §8.1). Re-runnable; atomic
tmp+rename writes only; flags > config default > CWD fallback.

options:
  --plan <file>           winning_project_plan.md (default: ./winning_project_plan.md)
  --manifest <file>       assembly.manifest.json or assembly_manifest.json (default: ./assembly.manifest.json)
  --config <file>         timing.yaml / timing.json (SCRIPT-01 boundaries + total)
  --event-profile <file>  optional event_profile.json (PROFILE-05 advisory total seed)
  --out <file.md>         output script path (default: ./script.md)
  --full-draft            emit the legacy timestamped table instead of the stub
                          (draft only — the recording script is demo-video-script.md)
  --validate              dry-run: check sources + timing sum, write nothing

exit codes:
  0  success (TODOs / blank template fallback are warns, not errors)
  1  blocking failure — invalid timing config or failed validation
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

//#region arg parsing

export interface CliArgs {
  command: "generate" | "validate";
  plan?: string;
  manifest?: string;
  config?: string;
  eventProfile?: string;
  out?: string;
  validateOnly: boolean;
}

/** Parse the documented flag surface (§8.1); unknown flags die with usage. */
export function parseArgs(argv: string[]): CliArgs {
  const known = new Set(["--plan", "--manifest", "--config", "--event-profile", "--out"]);
  // --full-draft is a boolean opt-in for the legacy timestamped table (see renderScriptStub).
  const args: CliArgs = { command: "generate", validateOnly: false };
  let i = 0;
  // Tolerate the binary-name token: `script generate ...` / `deckgen populate ...`
  // arrive with the tool name as argv[0] when invoked through the bin shim.
  if (argv[0] === "script") i = 1;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === "generate" || a === "validate") {
      args.command = a;
      i += 1;
      continue;
    }
    if (a === "--validate") {
      args.validateOnly = true;
      i += 1;
      continue;
    }
    if (known.has(a)) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) die(`error: ${a} requires a value\n\n${USAGE}`);
      if (a === "--plan") args.plan = value;
      else if (a === "--manifest") args.manifest = value;
      else if (a === "--config") args.config = value;
      else if (a === "--event-profile") args.eventProfile = value;
      else if (a === "--out") args.out = value;
      i += 2;
      continue;
    }
    die(`error: unknown argument ${a}\n\n${USAGE}`);
  }
  return args;
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** Default input paths per §7 precedence: flag > CWD fallback. */
function resolveInput(flagValue: string | undefined, cwdDefault: string): string {
  return flagValue ?? cwdDefault;
}

//#endregion

//#region manifest loading (§6.6 row: SCRIPT degrades cues to TODO, still exits 0)

let manifestSchemaCache: object | null = null;

function loadManifestSchema(): object {
  return (manifestSchemaCache ??= JSON.parse(
    readFileSync(join(REPO_ROOT, "contracts", "assembly-manifest.schema.json"), "utf8"),
  ) as object);
}

/**
 * loadManifest(path) → { manifest, ok }. Absent file → null silently (§6.6
 * non-blocking). Unparseable/RES-04-invalid JSON → warn + null so visual cues
 * degrade to TODO but headers are still written (exit stays 0).
 */
export function loadManifest(
  path: string,
  warn: (m: string) => void = (m) => console.warn(m),
): AssemblyManifestView | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    warn(`warn: assembly.manifest.json unreadable at ${path} (${err instanceof Error ? err.message : String(err)}) — visual cues degrade to TODO`);
    return null;
  }
  const result = validate(loadManifestSchema(), parsed);
  if (!result.valid || typeof parsed !== "object" || parsed === null) {
    warn(`warn: assembly.manifest.json invalid at ${path} — visual cues degrade to TODO`);
    return null;
  }
  return parsed as AssemblyManifestView;
}

//#endregion

//#region commands

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // Timing: hard gate (§6.6) — invalid/sum-mismatched timing exits 1 BEFORE any
  // generation because wrong timestamps would violate SCRIPT-AC-01. When no
  // --config is given, fall back to the checked-in module-default timing file.
  let timing;
  try {
    timing = loadTiming(args.config ?? (existsSync("timing.yaml") ? "timing.yaml" : existsSync("timing.json") ? "timing.json" : DEFAULT_TIMING_PATH));
  } catch (err) {
    if (err instanceof TimingValidationError) {
      console.error(`ERROR: timing config invalid at ${err.path}: ${err.message}. Fix sum == total.`);
      return 1;
    }
    throw err;
  }
  if (!timing) {
    console.error("ERROR: timing config missing — provide --config timing.yaml");
    return 1;
  }

  const planPath = resolveInput(args.plan, "winning_project_plan.md");
  let planText = "";
  if (args.plan !== undefined && !existsSync(planPath)) {
    console.warn(`warn: winning_project_plan.md not found at ${planPath} — spoken text degrades to TODO blocks`);
  } else if (existsSync(planPath)) {
    planText = readFileSync(planPath, "utf8");
  }

  const manifestPath = resolveInput(args.manifest, "assembly.manifest.json");
  const manifest = loadManifest(manifestPath);
  const profile = loadEventProfile(args.eventProfile ?? null);

  if (args.command === "validate" || args.validateOnly) return runValidate(args, timing, planPath, manifestPath);

  const outPath = args.out ?? "script.md";
  const fullDraft = argv.includes("--full-draft");

  // Default output is a STUB pointing at demo-video-script.md. This module cannot
  // see the built product, so a spoken-text draft from it is a plan-time guess —
  // the failure mode that shipped unusable scripts. --full-draft restores the old
  // timestamped table for anyone who wants the Hour-0 timing skeleton.
  if (!fullDraft) {
    const windows = computeWindows(timing);
    const totalMinutes = resolveTotalMinutes(timing, profile ?? null);
    const stub = renderScriptStub({
      totalMinutes,
      timingSource: timingSourceLabel(timing, profile ?? null),
      windows,
    });
    const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    const written = writeFileDiffAware(outPath, reconcileGeneratedAt(stub, previous));
    console.log(
      `script: wrote ${outPath} (stub — the recording script is demo-video-script.md, authored by DP-SCRIPT; --full-draft for the legacy table)${written ? "" : " [unchanged]"}`,
    );
    return 0;
  }

  const result = await generateScript({ plan: planText, manifest, timing, profile, writeTo: outPath });
  console.log(
    `script: wrote ${outPath} (DRAFT — not the recording script; total ${result.total_minutes} min via ${result.timing_source}, sections ${result.sections.length}${result.fallback ? `, FALLBACK ${result.fallback}` : ""})`,
  );
  return 0;
}

/** script validate — dry-run over sources + timing sum check; never writes. */
function runValidate(args: CliArgs, timing: NonNullable<ReturnType<typeof loadTiming>>, planPath: string, manifestPath: string): number {
  const sum = sumSectionMinutesOf(timing);
  const total = timing.total_minutes;
  if (total != null && Math.abs(sum - total) > 0.01) {
    console.error(`ERROR: timing validation: sum ${sum.toFixed(1)} != total ${Number(total).toFixed(1)} — adjust sections to sum to total`);
    return 1;
  }
  console.log(JSON.stringify({
    level: "ok",
    code: "timing_ok",
    total_minutes: total ?? "(derived)",
    sections: timing.sections.length,
    live_section: timing.sections.find((s) => s.live === true)?.id ?? "(none — generator assigns earliest non-Problem)",
  }));
  console.log(JSON.stringify({
    level: existsSync(planPath) ? "ok" : "warn",
    code: existsSync(planPath) ? "plan_ok" : "plan_missing",
    path: planPath,
  }));
  console.log(JSON.stringify({
    level: existsSync(manifestPath) ? "ok" : "warn",
    code: existsSync(manifestPath) ? "manifest_ok" : "manifest_missing",
    path: manifestPath,
  }));
  console.log("validate: OK — no files written (dry-run)");
  return 0;
}

function sumSectionMinutesOf(timing: { sections: Array<{ minutes: number }> }): number {
  return Math.round(timing.sections.reduce((s, sec) => s + sec.minutes, 0) * 10) / 10;
}

//#endregion

//#region entrypoint (colon alias normalization)

/**
 * Colon alias form (`script:generate --plan ...`): the subcommand may arrive
 * via the invoked script name instead of argv[2]; normalize both spellings.
 */
export function normalizeAlias(argv: string[], scriptName?: string): string[] {
  const name = basename(scriptName ?? "").replace(/\.(ts|js|mjs|cjs)$/i, "");
  const m = /^script[:_](\w+)$/.exec(name);
  if (!m) return argv;
  const sub = m[1] as string;
  const first = argv[0] ?? "";
  if ((sub === "generate" || sub === "validate") && (first.startsWith("-") || first === "")) {
    return [sub, ...argv];
  }
  return argv;
}

// Entry guard mirroring src/ideation/deckgen/cli.ts (node vs vite-node vs vitest).
const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
const invokedDirectly = argv1.endsWith("src/ideation/script/cli.ts");
const invokedViaViteNode =
  argv1.includes("vite-node") &&
  process.env["CHASSIS_DISPATCH"] === undefined &&
  process.env["VITEST"] === undefined;
if (invokedDirectly || invokedViaViteNode) {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "--help" || rawArgv[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  main(normalizeAlias(rawArgv, process.argv[1]))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Outermost GOV-RES-04 guard: DegradedResult-style log.
      console.error(
        `warn: degraded:true reason:"script_cli_failed" fallback_source:"none" original_error:${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
      process.exit(1);
    });
}

//#endregion
