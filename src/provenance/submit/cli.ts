// Requirement IDs: SUBMIT-01..04, SUBMIT-RES-01, GOV-REU-03, XCUT-08
// `submit` CLI — TypeScript twin of src/provenance/submit/cli.py (DP-J §5.4,
// §9.1). Flags, help text, output bytes and exit codes stay byte-compatible:
//
//   submit format --plan <p> --manifest <p> [--disclosure <p>]
//                 [--event-profile <p>] [--config <p>] [--out <p>]
//   submit hygiene --manifest <p> [--include-unstaged] [--config <p>]
//                  [--out hygiene-report]     # SUBMIT-05, DP-J §6
//   submit:format accepted as the subcommand token (npm ergonomics).
//
// Behavior contract (§8):
// - Pure function of inputs; atomic `write tmp + rename` output (SUBMIT-04).
// - event_profile.json defaults to ./event_profile.json when present else
//   null (PROFILE-05 graceful).
// - Hygiene is read-only and flag-only (SUBMIT-RES-02/NONGOAL-16); any
//   failure degrades to `unavailable` and never blocks formatting
//   (SUBMIT-RES-03). Exit 1 on an explicit `flagged` verdict — outputs are
//   still written first (operator block signal).
// - Outermost try/catch: exit 0 when formatting succeeded — even with field
//   gaps or degraded hygiene (SUBMIT-RES-01/03); exit 1 only on blocking
//   conditions (output I/O failure, unhandled error). Never a raw stack.
// - No network, no LLM call anywhere.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { validate } from "../../resilience/index.js";
import { validateManifest } from "../provo/validate.js";
import {
  WINNING_PLAN_FRONTMATTER_SCHEMA_PATH,
  parseSimpleYaml,
  splitFrontmatter,
} from "./extract.js";
import {
  HYGIENE_UNAVAILABLE_NOTE,
  formatSubmission,
  loadSubmitConfig,
} from "./format.js";
import { loadHygieneConfig, renderHygieneMarkdown, runHygiene } from "./hygiene.js";

function warn(message: string): void {
  process.stderr.write(`[submit] ${message}\n`);
}

// Deliberately NOT imported from ../provo/cli.js: that module runs its own
// CLI main-guard when loaded under vite-node, so a cross-CLI import would
// trigger a nested provo invocation. Both CLIs keep private copies of these
// two small helpers instead (byte-compatible twins of cli.py).
export function writeTextAtomically(targetPath: string, text: string): string {
  const out = resolve(targetPath);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = join(
    dirname(out),
    `.submit-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
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
  const directory = dirname(manifestPath);
  const base = directory ? manifestPath.slice(directory.length + 1) : manifestPath;
  const swapped = base.endsWith("_manifest.json")
    ? base.replace("_manifest.json", ".manifest.json")
    : base.replace(".manifest.json", "_manifest.json");
  if (swapped !== base) {
    const aliased = directory ? join(directory, swapped) : swapped;
    if (existsSync(aliased)) return aliased;
  }
  return manifestPath; // let the read fail with the user's original path
}

export {}

const USAGE = `submit — Platform Submission Copy Formatter (SUBMIT)

  submit format --plan winning_project_plan.md --manifest assembly.manifest.json
                [--disclosure disclosure.md] [--event-profile event_profile.json]
                [--config config/submit.json] [--out submission.md]
  submit:format --plan <path> --manifest <path>   # alias form (npm ergonomics)
  submit hygiene --manifest assembly.manifest.json [--include-unstaged]
                 [--config config/hygiene.json] [--out hygiene-report]
  submit --help

Notes:
  --plan accepts absolute/relative paths. Missing plan/disclosure render as
  explicit gap markers (SUBMIT-RES-01) — formatting still succeeds.
  --event-profile defaults to ./event_profile.json when present (PROFILE-05);
  pass an explicit path to override.
  \`format\` also runs the SUBMIT-05 hygiene guard as its advisory section;
  \`hygiene\` runs it standalone, writing <out>.json + <out>.md. Flag-only:
  hygiene never modifies anything (NONGOAL-16).

Exit codes: 0 on ANY successful write (gaps/degraded hygiene allowed) · 1 on
output I/O failure, unhandled error, or an explicit hygiene \`flagged\`
verdict (SUBMIT-05 operator block signal — outputs are still written).`;

interface FormatArgs {
  plan: string;
  manifest: string;
  disclosure?: string;
  eventProfile?: string;
  config?: string;
  out?: string;
}

interface HygieneArgs {
  manifest?: string;
  includeUnstaged: boolean;
  config?: string;
  out?: string;
}

/** SUBMIT-05 advisory phase shared by `format` and `hygiene` (DP-J §6.1:
 * 'Early-run hygiene is the same code path as late-run'). Never throws —
 * every failure degrades inside runHygiene (SUBMIT-RES-03). Returns
 * [report, warnings, sectionMarkdown] where sectionMarkdown is the rendered
 * human view minus its '# Hygiene report' top heading. Byte-twin of
 * _run_hygiene_phase in cli.py. */
function runHygienePhase(
  manifestPath: string | null,
  hygieneConfigFlag: string | undefined,
  includeUnstaged: boolean,
  now: string,
): [ReturnType<typeof runHygiene>[0], string[], string] {
  const { config, warnings } = loadHygieneConfig(hygieneConfigFlag ?? null);
  const [report, hygieneWarnings] = runHygiene(config, {
    repoRoot: process.cwd(),
    includeUnstaged,
    manifestPath: manifestPath ?? undefined,
    now,
  });
  warnings.push(...hygieneWarnings);
  const fullMd = renderHygieneMarkdown(report as never, warnings);
  const prefix = "# Hygiene report\n\n";
  const section = fullMd.startsWith(prefix) ? fullMd.slice(prefix.length) : fullMd;
  return [report, warnings, section];
}

/** Read a text input; missing/unreadable -> null (gap, SUBMIT-RES-01). */
function readText(path: string, what: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    warn(`warn: ${what} not readable at ${path} — rendering explicit gap (SUBMIT-RES-01)`);
    return null;
  }
}

function defaultEventProfilePath(): string | null {
  const candidate = join(process.cwd(), "event_profile.json");
  return existsSync(candidate) ? candidate : null;}

interface EventProfileData {
  fields: string[] | null;
  providerLabels: Record<string, string> | null;
  warnings: string[];
}

/** event_profile.json is advisory (PROFILE-05): malformed -> warn + ignore. */
function loadEventProfile(path: string | null): EventProfileData {
  if (path === null || !existsSync(path)) {
    if (path !== null) {
      warn(`warn: event profile not found at ${path} — ignored (PROFILE-05 graceful)`);
    }
    return { fields: null, providerLabels: null, warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      fields: null,
      providerLabels: null,
      warnings: [
        `warn: event profile unreadable at ${path}: ${(err as Error).message} — ignored (PROFILE-05 graceful)`,
      ],
    };
  }
  const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const warnings: string[] = [];
  let fields: string[] | null = null;
  if (Array.isArray(obj.submission_fields)) {
    fields = obj.submission_fields.filter((f): f is string => typeof f === "string");
  } else if (obj.submission_fields != null) {
    warnings.push(`warn: event profile submission_fields at ${path} is not a list — ignored`);
  }
  let providerLabels: Record<string, string> | null = null;
  if (
    typeof obj.provider_labels === "object" &&
    obj.provider_labels !== null &&
    !Array.isArray(obj.provider_labels)
  ) {
    providerLabels = Object.fromEntries(
      Object.entries(obj.provider_labels as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } else if (obj.provider_labels != null) {
    warnings.push(`warn: event profile provider_labels at ${path} is not an object — ignored`);
  }
  return { fields, providerLabels, warnings };
}

/** requires_providers union over included components; invalid/missing
 * manifest -> warn + empty (SUBMIT never blocks on ASM inputs). */
function extractManifestProviders(manifestText: string | null): string[] {
  if (manifestText === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    warn(`warn: manifest unparseable: ${(err as Error).message} — tech-stack providers skipped`);
    return [];
  }
  const check = validateManifest(parsed);
  if (!check.valid) {
    const detail = check.errors.map((e) => `${e.path} ${e.message}`).join("; ");
    warn(`warn: manifest invalid: ${detail} — tech-stack providers skipped (RES-04)`);
    return [];
  }
  const providers: string[] = [];
  for (const component of (parsed as { components?: Array<Record<string, unknown>> }).components ?? []) {
    if (component.included === true) {
      for (const provider of (component.requires_providers as string[] | undefined) ?? []) {
        providers.push(provider);
      }
    }
  }
  return providers;
}

/** Split + parse + RES-04-validate the plan's YAML frontmatter.
 * Returns [frontmatter|null, valid]. Invalid/absent -> [null, false] —
 * warn + proceed with body fallback (DP-J §5.1 step 1). */
export function loadValidatedFrontmatter(
  planText: string,
): [Record<string, unknown> | null, boolean] {
  const [raw] = splitFrontmatter(planText);
  if (raw === null) return [null, false];
  const parsed = parseSimpleYaml(raw);
  try {
    const schema = JSON.parse(readFileSync(WINNING_PLAN_FRONTMATTER_SCHEMA_PATH, "utf8")) as object;
    const check = validate(schema, parsed);
    if (!check.valid) {
      const detail = check.errors.map((e) => `${e.path} ${e.message}`).join("; ");
      warn(
        "warn: winning_project_plan.md frontmatter invalid per " +
          `contracts/winning-plan-frontmatter.schema.json: ${detail} — proceeding ` +
          "with body fallback (RES-04)",
      );
      return [null, false];
    }
    return [parsed, true];
  } catch (err) {
    warn(`warn: cannot load winning-plan-frontmatter schema: ${(err as Error).message} — body fallback`);
    return [null, false];
  }
}

/** Overall verdict of the most recent hygiene phase in this process (module-
 * scope handoff — mirrors cli.py's local variable without threading it
 * through formatSubmission's pure signature). */
let lastOverallVerdict: "flagged" | "clean" | "unavailable" | null = null;

function cmdFormat(args: FormatArgs): number {
  // Reset the per-invocation handoff (module scope would otherwise leak the
  // verdict across runs in-process — cli.py keeps this as a local).
  lastOverallVerdict = null;
  const planText = readText(args.plan, "winning project plan");
  const manifestPath = resolveManifestPath(args.manifest);
  const manifestText = readText(manifestPath, "manifest");
  let disclosureText: string | null = null;
  if (args.disclosure) {
    disclosureText = readText(args.disclosure, "disclosure");
  } else if (existsSync("disclosure.md")) {
    disclosureText = readText("disclosure.md", "disclosure");
  }

  const { config, warnings: configWarnings } = loadSubmitConfig(args.config ?? null);
  for (const warning of configWarnings) warn(warning);
  const profile = loadEventProfile(
    args.eventProfile !== undefined ? args.eventProfile : defaultEventProfilePath(),
  );
  for (const warning of profile.warnings) warn(warning);

  // provider_labels: explicit config mapping wins over the advisory
  // event-profile mapping (same precedence as fieldLabels, DP-J §5.1/§5.3).
  const configProviderLabels = config.provider_labels;
  const providerLabels = {
    ...(profile.providerLabels ?? {}),
    ...(typeof configProviderLabels === "object" && configProviderLabels !== null
      ? Object.fromEntries(
          Object.entries(configProviderLabels as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : {}),
  };

  const providers = extractManifestProviders(manifestText);
  const [frontmatter, frontmatterValid] = loadValidatedFrontmatter(planText ?? "");
  const now = new Date().toISOString(); // ms precision UTC with Z suffix

  // SUBMIT-05 advisory phase — same code path as the standalone `hygiene`
  // command (DP-J §6.1). Disabled via submit config → template section is
  // stripped downstream and no scan runs.
  const hygieneEnabled = (config.hygiene as { enabled?: boolean } | undefined)?.enabled ?? true;
  let hygieneSection: string = HYGIENE_UNAVAILABLE_NOTE;
  if (hygieneEnabled) {
    const [report, hygieneWarnings, section] = runHygienePhase(
      manifestText !== null ? resolveManifestPath(args.manifest) : null,
      undefined,
      false,
      now,
    );
    hygieneSection = section;
    lastOverallVerdict = report.overall;
    for (const warning of hygieneWarnings) warn(warning);
  }
  const result = formatSubmission(planText ?? "", providers, disclosureText, config, {
    eventProfileSubmissionFields: profile.fields,
    providerLabels,
    frontmatter,
    frontmatterValid,
    hygieneSummary: hygieneSection,
    now,
  });

  const outPath =
    args.out ??
    ((config.output as { path?: string } | undefined)?.path ?? "submission.md");
  writeTextAtomically(outPath, result.markdown);
  process.stdout.write(
    `submission copy: ${resolve(outPath)} (${result.not_extracted_fields.length} field(s) marked not extracted)\n`,
  );
  // Capture the flagged verdict from the phase we ran above.
  if (lastOverallVerdict !== null) {
    process.stdout.write(
      `hygiene (advisory): ${lastOverallVerdict.toUpperCase()} (SUBMIT-05 — see '## Hygiene' section)\n`,
    );
    if (lastOverallVerdict === "flagged") return 1;
  }
  process.stdout.write("ok — re-runnable pure function of plan+manifest+disclosure+config (SUBMIT-04)\n");
  return 0;
}

/** Standalone SUBMIT-05 run (DP-J §6.1): writes <out>.json (frozen
 * contracts/hygiene-report.schema.json shape) + <out>.md (human view).
 * Exit 0 clean/unavailable; 1 flagged (operator block signal). Byte-twin of
 * cmd_hygiene in cli.py. */
function cmdHygiene(args: HygieneArgs): number {
  const now = new Date().toISOString();
  const resolvedManifest = args.manifest ? resolveManifestPath(args.manifest) : null;
  const [report, warnings] = runHygienePhase(resolvedManifest, args.config, args.includeUnstaged, now);
  for (const warning of warnings) warn(warning);
  const base = args.out ?? "hygiene-report";
  const jsonPath = base.endsWith(".json") ? base : `${base}.json`;
  const mdBase = jsonPath.slice(0, -5); // strip ".json"
  const mdPath = `${mdBase}.md`;
  const writtenJson = writeTextAtomically(jsonPath, JSON.stringify(report, null, 2) + "\n");
  const fullMd = renderHygieneMarkdown(report as never, warnings);
  const writtenMd = writeTextAtomically(mdPath, fullMd);
  const scan = report.secret_scan as { status: string };
  const dist = report.commit_distribution as { status: string };
  process.stdout.write(
    `hygiene report: ${writtenJson} + ${writtenMd} ` +
      `(secret scan ${scan.status}, commit distribution ${dist.status}, overall ${report.overall})\n`,
  );
  return report.overall === "flagged" ? 1 : 0;
}

export function runSubmitCli(argv: string[]): number {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return argv.length === 0 ? 1 : 0;
  }
  // Colon-alias acceptance: `submit:format` subcommand token.
  const normalized = argv.map((a) => (a === "submit:format" ? "format" : a));
  const command = normalized[0];
  if (command !== "format" && command !== "hygiene") {
    process.stderr.write(`ERROR: unknown submit command "${command}"\n`);
    return 1;
  }
  const valueFlags = new Set(["--plan", "--manifest", "--disclosure", "--event-profile", "--config", "--out"]);
  const booleanFlags = new Set(["--include-unstaged"]);
  if (command === "hygiene") {
    const hygieneArgs: HygieneArgs = { includeUnstaged: false };
    for (let i = 1; i < normalized.length; i++) {
      const flag = normalized[i];
      if (flag === undefined || (!valueFlags.has(flag) && !booleanFlags.has(flag))) {
        process.stderr.write(`ERROR: unknown flag "${flag ?? ""}" — see submit --help\n`);
        return 1;
      }
      if (booleanFlags.has(flag)) {
        hygieneArgs.includeUnstaged = true;
        continue;
      }
      const value: string | undefined = normalized[i + 1];
      if (value === undefined || value.startsWith("--")) {
        process.stderr.write(`ERROR: flag ${flag} requires a value\n`);
        return 1;
      }
      switch (flag) {
        case "--manifest": hygieneArgs.manifest = value; break;
        case "--config": hygieneArgs.config = value; break;
        case "--out": hygieneArgs.out = value; break;
        default: break;
      }
      i++;
    }
    try {
      return cmdHygiene(hygieneArgs);
    } catch (err) {
      process.stderr.write(`ERROR: submit hygiene failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const args: FormatArgs = {
    plan: "winning_project_plan.md",
    manifest: "assembly.manifest.json",
  };
  const flagsWithValues = new Set([
    "--plan",
    "--manifest",
    "--disclosure",
    "--event-profile",
    "--config",
    "--out",
  ]);
  for (let i = 1; i < normalized.length; i++) {
    const flag = normalized[i];
    if (flag === undefined || !flagsWithValues.has(flag)) {
      process.stderr.write(`ERROR: unknown flag "${flag ?? ""}" — see submit --help\n`);
      return 1;
    }
    const value: string | undefined = normalized[i + 1];
    if (value === undefined || value.startsWith("--")) {
      process.stderr.write(`ERROR: flag ${flag} requires a value\n`);
      return 1;
    }
    switch (flag) {
      case "--plan": args.plan = value; break;
      case "--manifest": args.manifest = value; break;
      case "--disclosure": args.disclosure = value; break;
      case "--event-profile": args.eventProfile = value; break;
      case "--config": args.config = value; break;
      case "--out": args.out = value; break;
    }
    i++;
  }
  try {
    return cmdFormat(args);
  } catch (err) {
    // §8 outermost guard: clear message, never a raw stack.
    process.stderr.write(`ERROR: submit format failed: ${(err as Error).message}\n`);
    return 1;
  }
}

const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const invokedDirectly = argv1.endsWith("src/provenance/submit/cli.ts");
const invokedViaViteNode =
  argv1.includes("vite-node") &&
  process.env["CHASSIS_DISPATCH"] === undefined &&
  process.env["VITEST"] === undefined;
if (invokedDirectly || invokedViaViteNode) {
  process.exit(runSubmitCli(process.argv.slice(2)));
}

// __MAIN__
