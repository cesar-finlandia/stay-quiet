// Requirement IDs: PROV-01, PROV-03, PROV-05, PROV-RES-01, GOV-RES-02, XCUT-08
// `provo` CLI — TypeScript twin of src/provenance/provo/cli.py (DP-J §9.1).
//   provo generate --manifest <p> [--ai-log <p>|tool:scope ...] [--out <p>] [--config <p>]
//   provo summary  --manifest <p> [--out <p>]
// Colon aliases `provo:generate` / `provo:summary` are accepted as the
// subcommand token (npm-script ergonomics per DP-J §9.1).
//
// Behavior contract (§8):
// - Atomic `write tmp + rename` for every output; no partial files ever.
// - `generate` writes disclosure.md AND architecture-summary.md plus the
//   identical-bytes architecture_summary.txt alias (all share one
//   source_manifest_hash). `summary` writes only the summary pair.
// - Outermost try/catch: ManifestValidationError/CatalogError/print a clear
//   message and exit 1 ONLY when manifest validation or catalog coverage
//   blocks generation; any successful write exits 0 even with warnings.
// - No network, no LLM call anywhere (PROV-REU-01).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  CatalogError,
  ManifestValidationError,
  generateDisclosure,
  parseAiLog,
  parseAndValidateManifest,
} from "./generate.js";
import type {
  AiToolLogEntry,
  ComponentCatalog,
  DisclosureConfig,
} from "./generate.js";
import { buildArchitectureSummary } from "./summary.js";
import {
  CATALOG_PATH,
  DEFAULT_DISCLOSURE_CONFIG_PATH,
  DISCLOSURE_CONFIG_SCHEMA_PATH,
  REPO_ROOT,
  validate,
  validateAiLogEntry,
} from "./validate.js";

const USAGE = `provo — Disclosure Generator (PROV)

  provo generate --manifest assembly.manifest.json [--ai-log ai_tools.json] [--out disclosure.md] [--config config/disclosure.json]
  provo summary  --manifest assembly.manifest.json [--out architecture-summary.md]
  provo:generate --manifest <path>        # alias form (npm script ergonomics)
  provo:summary  --manifest <path>        # alias form
  provo --help

Notes:
  --manifest accepts absolute/relative paths; the DP-G §3.1 alias filename
  assembly_manifest.json is resolved automatically when the dotted name is absent.
  --ai-log accepts a JSON file path and/or repeated inline tool:scope pairs
  (e.g. --ai-log Cursor:"scaffolded tests"). Malformed entries warn + skip;
  an empty log simply omits the AI assistance section (PROV-RES-01).

Exit codes: 0 on ANY successful write (warnings allowed) · 1 when manifest
validation or catalog coverage blocked generation (ASM-RES-01, accuracy over
availability) · 1 on output I/O failure.`;

function warn(message: string): void {
  console.error(`[provo] ${message}`);
}

//#region Atomic output (DP-J §3.3 — tmp + rename, never partial)

export function writeTextAtomically(targetPath: string, text: string): string {
  const out = resolve(targetPath);
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.provo-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, out);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return out;
}

/** DP-G §3.1 alias: dotted assembly.manifest.json ↔ underscore
 * assembly_manifest.json resolved transparently (either direction). */
export function resolveManifestPath(manifestPath: string): string {
  if (existsSync(manifestPath)) return manifestPath;
  const dir = dirname(manifestPath);
  const base = manifestPath.split(/[\\/]/).pop() ?? manifestPath;
  const swapped = /_manifest\.json$/.test(base)
    ? base.replace(/_manifest\.json$/, ".manifest.json")
    : base.replace(/\.manifest\.json$/, "_manifest.json");
  if (swapped !== base) {
    const aliased = dir === "." ? swapped : join(dir, swapped);
    if (existsSync(aliased)) return aliased;
  }
  return manifestPath; // let the read fail with the user's original path
}

//#endregion

//#region Config + catalog + ai-log inputs

function loadDisclosureConfig(configPath: string | undefined): DisclosureConfig {
  const path = configPath ?? DEFAULT_DISCLOSURE_CONFIG_PATH;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    if (configPath === undefined) return {}; // checked-in default absent → pure defaults
    warn(`warn: disclosure config not found at ${path} — using safe defaults (GOV-RES-02)`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    const schema = JSON.parse(readFileSync(DISCLOSURE_CONFIG_SCHEMA_PATH, "utf8")) as object;
    const res = validate(schema, parsed);
    if (!res.valid) {
      warn(
        `warn: disclosure config invalid at ${path}: ${res.errors.map((e) => `${e.path} ${e.message}`).join("; ")} — using safe defaults (GOV-RES-02)`,
      );
      return {};
    }
    return parsed as DisclosureConfig;
  } catch {
    warn(`warn: disclosure config unreadable at ${path} — using safe defaults (GOV-RES-02)`);
    return {};
  }
}

function loadCatalog(): ComponentCatalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as ComponentCatalog;
}

/** --ai-log values may be a JSON file path OR inline `tool:scope` (repeated).
 * Returns the combined log serialized as one JSON array string (or null when
 * empty) plus skip-warnings — malformed entries never block (PROV-RES-01). */
export function resolveAiLogInputs(values: string[]): {
  aiLogJson: string | null;
  warnings: string[];
} {
  const entries: AiToolLogEntry[] = [];
  const warnings: string[] = [];
  for (const value of values) {
    if (existsSync(value) && statSync(value).isFile()) {
      let bytes: string;
      try {
        bytes = readFileSync(value, "utf8");
      } catch {
        warnings.push(`warn: cannot read ai-log file ${value} — skipped (PROV-RES-01)`);
        continue;
      }
      // Reuse the generator's parser for uniform warn+skip semantics.
      const parsed = parseAiLog(bytes);
      warnings.push(...parsed.warnings.map((w) => w.replace(/^warn: /, `warn: ${value}: `)));
      entries.push(...parsed.entries);
      continue;
    }
    // Inline shorthand tool:scope — split on the FIRST colon; surrounding
    // quotes on the scope are stripped (§9.1 example Cursor:"scaffolded tests").
    const idx = value.indexOf(":");
    if (idx <= 0) {
      warnings.push(`warn: ai-log value "${value}" is neither a file nor tool:scope — skipped`);
      continue;
    }
    const tool = value.slice(0, idx);
    let scope = value.slice(idx + 1);
    if (
      (scope.startsWith('"') && scope.endsWith('"')) ||
      (scope.startsWith("'") && scope.endsWith("'"))
    ) {
      scope = scope.slice(1, -1);
    }
    const check = validateAiLogEntry({ tool, scope });
    if (check.valid) entries.push({ tool, scope });
    else {
      warnings.push(
        `warn: inline ai-log entry skipped (malformed): ${check.errors.map((e) => `${e.path} ${e.message}`).join("; ")} (GOV-RES-02)`,
      );
    }
  }
  return { aiLogJson: entries.length > 0 ? JSON.stringify(entries, null, 2) : null, warnings };
}

//#region Command handlers

interface ParsedArgs {
  command: string | null;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  let i = 0;
  let command: string | null = null;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) break;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const value = argv[i + 1];
      const list = flags.get(name) ?? [];
      if (value !== undefined && !value.startsWith("--")) {
        list.push(value);
        i += 2;
      } else {
        list.push("");
        i += 1;
      }
      flags.set(name, list);
    } else {
      if (command === null) command = a;
      i += 1;
    }
  }
  return { command, flags };
}

function readManifestBytes(manifestPath: string): { bytes: string; path: string } {
  const resolved = resolveManifestPath(manifestPath);
  try {
    return { bytes: readFileSync(resolved, "utf8"), path: resolved };
  } catch (e) {
    const code = (e as { code?: string }).code ?? String(e);
    throw new ManifestValidationError(
      "/",
      `cannot read manifest at ${resolved} (${code}) — run assembly first (ASM-04)`,
      "manifest_unreadable",
    );
  }
}

function normalizeCommand(command: string | null, invokedAlias: string | null): string | null {
  const raw = (command ?? invokedAlias ?? "").toLowerCase();
  if (raw === "") return null;
  const stripped = raw.startsWith("provo:") ? raw.slice("provo:".length) : raw;
  if (stripped === "generate" || stripped === "summary") return stripped;
  return raw; // unknown — caller prints usage
}

function cmdGenerate(
  manifestFlag: string,
  flags: Map<string, string[]>,
  outPath: string,
  configPath: string | undefined,
): number {
  const { bytes } = readManifestBytes(manifestFlag);
  const { aiLogJson, warnings: aiWarnings } = resolveAiLogInputs(flags.get("ai-log") ?? []);
  for (const w of aiWarnings) warn(w);

  const catalog = loadCatalog();
  const config = loadDisclosureConfig(configPath);
  const result = generateDisclosure(bytes, aiLogJson, catalog, config);

  const writtenDisclosure = writeTextAtomically(outPath, result.disclosure_text + "\n");
  const summaryDir = dirname(resolve(outPath));
  const writtenSummaryMd = writeTextAtomically(
    join(summaryDir, "architecture-summary.md"),
    result.architecture_summary + "\n",
  );
  const writtenSummaryTxt = writeTextAtomically(
    join(summaryDir, "architecture_summary.txt"),
    result.architecture_summary + "\n",
  );

  console.log(
    `disclosure: ${writtenDisclosure} (${result.components_reused.length} component(s) reused, manifest hash ${result.source_manifest_hash.slice(0, 12)}…)`,
  );
  console.log(`architecture summary (PROV-05): ${writtenSummaryMd}`);
  console.log(`architecture summary alias: ${writtenSummaryTxt}`);
  if (result.warnings.length > 0) {
    for (const w of result.warnings) warn(w);
  }
  console.log("ok — disclosure is the single source for DECKGEN-02 / SUBMIT-02 / FAQDEF-02 (contract #8)");
  return 0;
}

function cmdSummary(manifestFlag: string, outPath: string, configPath: string | undefined): number {
  const { bytes } = readManifestBytes(manifestFlag);
  // Validate + parse via the shared path so invalid manifests block here too.
  parseAndValidateManifest(bytes);

  const catalog = loadCatalog();
  const config = loadDisclosureConfig(configPath);
  const manifest = JSON.parse(bytes) as Parameters<typeof buildArchitectureSummary>[0];
  const summary = buildArchitectureSummary(manifest, catalog, config);

  const writtenSummaryMd = writeTextAtomically(outPath, summary.summary_text + "\n");
  const summaryDir = dirname(resolve(outPath));
  const writtenSummaryTxt = writeTextAtomically(
    join(summaryDir, "architecture_summary.txt"),
    summary.summary_text + "\n",
  );
  console.log(`architecture summary (PROV-05): ${writtenSummaryMd}`);
  console.log(`architecture summary alias: ${writtenSummaryTxt}`);
  return 0;
}

//#region Entry

export function runProvoCli(argv: string[]): number {
  // Colon-alias detection: bin name provo:generate / provo:summary (§9.1).
  const invoked = process.argv[1]?.replace(/\\/g, "/") ?? "";
  const base = invoked.split("/").pop() ?? "";
  const invokedAlias = base.startsWith("provo:") ? base : null;

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  const parsed = parseArgs(argv);
  const command = normalizeCommand(parsed.command, invokedAlias);
  const flag = (name: string): string | undefined => parsed.flags.get(name)?.[0];
  const manifestFlag = flag("manifest") ?? join(process.cwd(), "assembly.manifest.json");

  try {
    switch (command) {
      case "generate":
        return cmdGenerate(manifestFlag, parsed.flags, flag("out") ?? "disclosure.md", flag("config"));
      case "summary":
        return cmdSummary(manifestFlag, flag("out") ?? "architecture-summary.md", flag("config"));
      default:
        console.log(USAGE);
        return 1;
    }
  } catch (err) {
    // §8 outermost guard: clear message; exit 1 only when generation was
    // BLOCKED (manifest validation / catalog coverage). Never a raw stack.
    if (err instanceof ManifestValidationError) {
      console.error(`ERROR: invalid manifest at ${err.path}: ${err.message}`);
      return 1;
    }
    if (err instanceof CatalogError) {
      console.error(`ERROR: ${err.message}`);
      return 1;
    }
    console.error(
      `ERROR: provo ${command ?? "<command>"} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
// Entry guard mirroring src/profile/cli.ts: direct node AND vite-node runs
// (VITEST workers excluded so suites can import runProvoCli safely).
const invokedDirectly = argv1.endsWith("src/provenance/provo/cli.ts");
const invokedViaViteNode =
  argv1.includes("vite-node") &&
  process.env["CHASSIS_DISPATCH"] === undefined &&
  process.env["VITEST"] === undefined;
if (invokedDirectly || invokedViaViteNode) {
  process.exit(runProvoCli(process.argv.slice(2)));
}
