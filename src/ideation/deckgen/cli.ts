#!/usr/bin/env node
// Requirement IDs: DECKGEN-01..06, DECKGEN-RES-01, DECKGEN-RES-02, GOV-RES-01,
// GOV-RES-04, ASM-RES-01, XCUT-08 — DP-D2a §6.3/§6.6/§8.1 (CLI surface).
//
// deckgen populate --plan <p> --manifest <m> --disclosure <d> --out <dir|file.md>
//                 [--no-llm] [--validate]
// deckgen diagram  --manifest <m> --out deck/diagram.mmd        (DECKGEN-03 standalone)
// deckgen validate --plan <p> --manifest <m> --disclosure <d>   (dry-run, no writes)
//
// Colon alias form for npm-script ergonomics: `deckgen:populate ...` etc. —
// package.json registers the same cli.ts under both bin names; argv[0]'s
// basename is normalized so both spellings dispatch identically.
//
// Exit codes (§8.1): 0 success — TODOs and DECKGEN-RES-02 skeleton fallback are
// warn-only; 1 blocking failure (invalid manifest per ASM-RES-01 pattern,
// failed validation); unhandled throws map to a DegradedResult-style log with
// an output file guaranteed on disk (GOV-RES-04) — never a partial write.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { generateDiagram, ManifestValidationError, type ComponentCatalog } from "./diagram.js";
import { populateDeck } from "./populate.js";
import { makeDeckgenPhraser } from "./phrase.js";

export const USAGE = `usage:
  deckgen populate --plan <file> [--manifest <file>] [--disclosure <file>] --out <dir|file.md>
                   [--no-llm] [--validate]
  deckgen diagram --manifest <file> --out <file.mmd>
  deckgen validate --plan <file> --manifest <file> [--disclosure <file>]
  deckgen:populate|deckgen:diagram|deckgen:validate ...   colon alias forms

Deck & diagram auto-populator (DP-D2a §8.1). Re-runnable; atomic tmp+rename
writes only. Flags: flag > config/deckgen.json default > CWD fallback.

options:
  --plan <file>         winning_project_plan.md (default: ./winning_project_plan.md)
  --manifest <file>     assembly.manifest.json or assembly_manifest.json (default: ./assembly.manifest.json)
  --disclosure <file>   disclosure.md from PROV-01 (default: ./disclosure.md)
  --out <dir|file.md>   output directory, or a single deck .md path (trailing .md auto-detected)
  --no-llm              skip LLM phrasing — extractive bullets only (offline-viable)
  --validate            dry-run: check sources, write nothing, exit 0/1

exit codes:
  0  success (TODO markers / RES-02 skeleton fallback are warns, not errors)
  1  blocking failure — invalid manifest (ASM-RES-01) or failed validation
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

//#region arg parsing + shared inputs

export interface CliArgs {
  command: "populate" | "diagram" | "validate";
  plan?: string;
  manifest?: string;
  disclosure?: string;
  out?: string;
  noLlm: boolean;
  validateOnly: boolean;
}

/** Parse the documented flag surface (§8.1); unknown flags die with usage. */
export function parseArgs(argv: string[]): CliArgs {
  const known = new Set(["--plan", "--manifest", "--disclosure", "--out", "--catalog"]);
  const args: CliArgs = {
    command: "populate",
    noLlm: false,
    validateOnly: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === "populate" || a === "diagram" || a === "validate") {
      args.command = a;
      i += 1;
      continue;
    }
    if (a === "--no-llm") {
      args.noLlm = true;
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
      else if (a === "--disclosure") args.disclosure = value;
      else if (a === "--out") args.out = value;
      i += 2;
      continue;
    }
    die(`error: unknown argument ${a}\n\n${USAGE}`);
  }
  return args;
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const CATALOG_PATH = join(REPO_ROOT, "contracts", "component-catalog.json");
const CONFIG_PATH = join(REPO_ROOT, "config", "deckgen.json");
const MODULE_DEFAULTS_PATH = join(REPO_ROOT, "src", "ideation", "deckgen", "config", "defaults.json");

export interface DeckgenConfig {
  outputDir: string;
  plan: string;
  manifest: string;
  disclosure: string;
}

/** config/deckgen.json → module defaults fallback; malformed → warn, never crash (GOV-RES-02). */
export function loadDeckgenConfig(): DeckgenConfig {
  const fallback: DeckgenConfig = {
    outputDir: "deck/",
    plan: "winning_project_plan.md",
    manifest: "assembly.manifest.json",
    disclosure: "disclosure.md",
  };
  for (const p of [CONFIG_PATH, MODULE_DEFAULTS_PATH]) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        output?: { dir?: string };
        inputs?: { plan?: string; manifest?: string; disclosure?: string };
      };
      return {
        outputDir: raw.output?.dir ?? fallback.outputDir,
        plan: raw.inputs?.plan ?? fallback.plan,
        manifest: raw.inputs?.manifest ?? fallback.manifest,
        disclosure: raw.inputs?.disclosure ?? fallback.disclosure,
      };
    } catch (err) {
      console.warn(`warn: deckgen config unreadable at ${p} (${err instanceof Error ? err.message : String(err)}) — using defaults`);
    }
  }
  return fallback;
}

function loadCatalog(): ComponentCatalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as ComponentCatalog;
}

//#region source loading (DECKGEN-RES-02 §6.3 / §6.6 guard table)

export interface Sources {
  planText: string;
  planMissing: boolean;
  /** Parsed manifest, or null when the file is absent (non-blocking). */
  manifest: unknown;
  disclosureText: string | null;
  disclosureMissing: boolean;
}

/**
 * Load plan/manifest/disclosure bytes. Manifest INVALID (unparseable JSON or
 * RES-04 schema failure) is BLOCKING here — ERROR + exit 1 per §6.6 — so it is
 * validated eagerly via generateDiagram against the checked-in contract.
 */
export function loadSources(args: CliArgs, config: DeckgenConfig): { sources: Sources; catalog: ComponentCatalog } | number {
  const catalog = loadCatalog();

  // Plan: flag > config default > CWD fallback. Missing file → skeleton mode.
  const planPath = args.plan ?? config.plan;
  let planText = "";
  let planMissing = false;
  try {
    if (existsSync(planPath)) {
      planText = readFileSync(planPath, "utf8");
    } else {
      planMissing = true;
    }
  } catch (err) {
    planMissing = true;
    console.warn(`warn: winning_project_plan.md unreadable at ${planPath} (${err instanceof Error ? err.message : String(err)})`);
  }

  // Manifest: absent file → null (diagram omitted, TODO note, non-blocking).
  const manifestPath = args.manifest ?? config.manifest;
  let manifest: unknown = null;
  if (existsSync(manifestPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      console.error(`ERROR: invalid manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    try {
      generateDiagram(parsed, catalog); // RES-04 validation against contract #6
    } catch (err) {
      if (err instanceof ManifestValidationError) {
        console.error(`ERROR: invalid manifest at ${manifestPath}: ${err.message} — ${err.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
        return 1;
      }
      throw err;
    }
    manifest = parsed;
  }

  // Disclosure: PROV-01 bytes; absence leaves the PIT-03 placeholder + warn.
  const disclosurePath = args.disclosure ?? config.disclosure;
  let disclosureText: string | null = null;
  let disclosureMissing = false;
  if (disclosurePath && existsSync(disclosurePath)) {
    disclosureText = readFileSync(disclosurePath, "utf8");
  } else if (args.disclosure || args.command !== "validate") {
    disclosureMissing = true;
  }

  return { sources: { planText, planMissing, manifest, disclosureText, disclosureMissing }, catalog };
}

//#endregion

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const config = loadDeckgenConfig();

  const loaded = loadSources(args, config);
  if (typeof loaded === "number") return loaded;
  const { sources, catalog } = loaded;

  if (args.command === "diagram") return runDiagram(args, sources, catalog);
  if (args.command === "validate") return runValidate(args, sources);
  return runPopulate(args, config, sources, catalog);
}

//#region populate

/**
 * deckgen populate — full population via populateDeck. --validate turns this
 * into a dry-run (no writes). Any unhandled throw is caught, a skeleton is
 * written best-effort so an output file always exists, and a DegradedResult-
 * style line is logged (GOV-RES-04) — exit stays 0 (GOV-RES-01).
 */
async function runPopulate(
  args: CliArgs,
  config: DeckgenConfig,
  sources: Sources,
  catalog: ComponentCatalog,
): Promise<number> {
  const outArg = args.out ?? config.outputDir;
  // §8.1: --out auto-detects directory vs single .md file by trailing `.md`.
  const singleFile = outArg.endsWith(".md") ? resolve(outArg) : null;
  const outDir = singleFile ? dirname(singleFile) : resolve(outArg);

  if (args.validateOnly) {
    const code = validateSources(sources);
    console.log(`validate: ${code === 0 ? "OK" : "FAILED"} — no files written (dry-run)`);
    return code;
  }

  try {
    const result = await populateDeck({
      planText: sources.planText,
      planMissing: sources.planMissing,
      manifest: sources.manifest,
      disclosureText: sources.disclosureText,
      catalog,
      outDir,
      phraser: args.noLlm ? undefined : makeDeckgenPhraser(),
    });
    if (singleFile) {
      const deckBytes = readFileSync(join(outDir, "deck.md"), "utf8");
      writeTextAtomic(singleFile, deckBytes);
      console.log(`wrote ${singleFile} (deck copy; per-slot files in ${outDir})`);
    }
    console.log(`populate: ${result.written.length} file(s) written, ${result.skippedUnchanged.length} unchanged in ${result.outDir}`);
    return 0;
  } catch (err) {
    // GOV-RES-04 — unhandled throw → DegradedResult-style log + output exists.
    console.warn(
      `warn: degraded:true reason:"deckgen_populate_failed" fallback_source:"none" original_error:${JSON.stringify(err instanceof Error ? err.message : String(err))} — wrote PIT-01 skeleton so an output file exists`,
    );
    try {
      await populateDeck({
        planText: "",
        planMissing: true,
        manifest: null,
        disclosureText: null,
        catalog,
        outDir,
      });
    } catch {
      /* even the skeleton path failed — nothing further to do without throwing */
    }
    return 0;
  }
}

//#region diagram / validate

function writeTextAtomic(outPath: string, text: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, outPath);
}

/** deckgen diagram — DECKGEN-03 standalone. Invalid manifest already exits 1. */
function runDiagram(args: CliArgs, sources: Sources, catalog: ComponentCatalog): number {
  if (!args.out) die(`error: deckgen diagram requires --out <file.mmd>\n\n${USAGE}`);
  if (args.validateOnly) return validateSources(sources);
  if (sources.manifest == null) {
    console.warn("warn: no manifest — run assembly first; diagram omitted");
    return 0;
  }
  try {
    const diagram = generateDiagram(sources.manifest, catalog);
    writeTextAtomic(resolve(args.out), diagram);
    console.log(`diagram: wrote ${resolve(args.out)}`);
    return 0;
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      console.error(`ERROR: invalid manifest: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/** Structured dry-run report; §6.3 — skeleton fallback is warn-only, exit 0. */
function validateSources(sources: Sources): number {
  if (sources.planMissing) {
    console.log(JSON.stringify({ level: "warn", code: "plan_missing", message: "winning_project_plan.md not found — populate degrades to PIT-01 skeleton (non-blocking)" }));
  } else if (sources.planText.trim() === "") {
    console.log(JSON.stringify({ level: "warn", code: "plan_empty", message: "winning_project_plan.md empty — populate degrades to PIT-01 skeleton (non-blocking)" }));
  } else {
    console.log(JSON.stringify({ level: "ok", code: "plan_ok" }));
  }
  if (sources.manifest == null) {
    console.log(JSON.stringify({ level: "warn", code: "manifest_missing", message: "assembly.manifest.json not found — diagram omitted with TODO note (non-blocking)" }));
  } else {
    console.log(JSON.stringify({ level: "ok", code: "manifest_ok" }));
  }
  if (sources.disclosureMissing || sources.disclosureText == null) {
    console.log(JSON.stringify({ level: "warn", code: "disclosure_missing", message: "disclosure.md not found — slot 08 left as PIT-03 placeholder on populate (non-blocking)" }));
  } else {
    console.log(JSON.stringify({ level: "ok", code: "disclosure_ok" }));
  }
  return 0; // §6.3: skeleton fallback is warn-only — validate still returns 0
}

/** deckgen validate — pure dry-run over the three sources; never writes. */
function runValidate(args: CliArgs, sources: Sources): number {
  const code = validateSources(sources);
  console.log(`validate: ${code === 0 ? "OK" : "FAILED"} — no files written (dry-run)`);
  return code;
}

//#endregion

//#region entrypoint (colon alias normalization)

import { basename } from "node:path";

/**
 * Colon alias form (`deckgen:populate --plan ...`): the subcommand may arrive
 * via the invoked script name instead of argv[2]; normalize so both spellings
 * dispatch identically. Direct `deckgen populate ...` is unaffected.
 */
export function normalizeAlias(argv: string[], scriptName?: string): string[] {
  const name = basename(scriptName ?? "").replace(/\.(ts|js|mjs|cjs)$/i, "");
  const m = /^deckgen[:_](\w+)$/.exec(name);
  if (!m) return argv;
  const sub = m[1] as string;
  const first = argv[0] ?? "";
  if (sub === "populate" || sub === "diagram" || sub === "validate") {
    if (first !== sub && !first.startsWith("-")) return [sub, ...argv];
    if (first.startsWith("-") || first === "") return [sub, ...argv];
  }
  return argv;
}

// Entry guard mirroring src/pgm/cli.ts: handles both node (argv[1] is this
// file) and vite-node (argv[1] is vite-node's cli.mjs; user args still start at
// index 2). VITEST workers are excluded so suites can import main() safely.
const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
const invokedDirectly = argv1.endsWith("src/ideation/deckgen/cli.ts");
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
        `warn: degraded:true reason:"deckgen_cli_failed" fallback_source:"none" original_error:${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
      process.exit(1);
    });
}

//#endregion
