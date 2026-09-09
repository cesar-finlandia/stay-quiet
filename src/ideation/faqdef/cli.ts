// Requirement IDs: FAQDEF-01..05, FAQDEF-RES-01, XCUT-06, XCUT-08 | Owned by M14 step 4/5 (DP-D2b §9.1)
// CLI surface (§9.1):
//   faqdef generate --plan <file> --manifest <file> [--disclosure <file>]
//                   [--profile <file>] [--config config/faqdef.json] [--out docs/qa]
//   faqdef rehearse --qa docs/qa/qa-sheet.md [--count 5] [--budget 90]
//                   [--axes business_value,application_of_technology]   (step 5)
// Aliases (§9.1): faqdef:generate / faqdef:gen → generate ·
// faqdef:rehearse → rehearse (accepted as argv token AND inferred from
// npm_lifecycle_event when invoked via `npm run faqdef:rehearse`).
// Exit codes: 0 ok (incl. fallback) · 1 named failure · 2 usage.
// Rehearsal dispatch lives in rehearse.ts (step 5) and is imported lazily so
// generate-only runs never load its dependencies.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFaqdefSheet } from "./generate.js";
import { runRehearsal } from "./rehearse.js";

export const USAGE = `usage:
  faqdef generate --plan <file> --manifest <file> [--disclosure <file>] [--profile <file>]
                  [--config <file>] [--out <dir>]
  faqdef rehearse --qa <file> [--count <n>] [--budget <s>] [--axes <list>]

aliases:
  faqdef:generate | faqdef:gen   same as "faqdef generate"
  faqdef:rehearse                same as "faqdef rehearse"

options:
  --plan <file>        required (generate): winning_project_plan.md
  --manifest <file>    required (generate): assembly.manifest.json (.json / _manifest alias)
  --disclosure <file>  optional: disclosure.md; architecture-summary.md sibling reused verbatim
  --profile <file>     optional: event_profile.json (sponsor tracks); absent never blocks
  --config <file>      optional: config/faqdef.json (defaults apply when absent/invalid)
  --out <dir>          output dir (default docs/qa)
  -h, --help           show this help and exit`;

export interface ParsedFaqdefArgs {
  command?: "generate" | "rehearse";
  plan?: string;
  manifest?: string;
  disclosure?: string;
  profile?: string;
  config?: string;
  out?: string;
  qa?: string;
  count?: number;
  budget?: number;
  axes?: string[];
  noStrict?: boolean;
  log?: string;
  help?: boolean;
}

const VALUE_FLAGS: Array<[string, keyof ParsedFaqdefArgs]> = [
  ["--plan", "plan"],
  ["--manifest", "manifest"],
  ["--disclosure", "disclosure"],
  ["--profile", "profile"],
  ["--config", "config"],
  ["--out", "out"],
  ["--qa", "qa"],
];

/** Pure arg parsing — unit-testable without process side effects. */
export function parseFaqdefArgs(argv: string[]): { ok: boolean; args?: ParsedFaqdefArgs; message?: string } {
  const args: ParsedFaqdefArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "generate" || arg === "rehearse") {
      args.command = args.command ?? arg;
      continue;
    }
    // §9.1 colon aliases accepted directly on argv (`faqdef:rehearse --qa …`).
    if (arg === "faqdef:generate" || arg === "faqdef:gen") {
      args.command = args.command ?? "generate";
      continue;
    }
    if (arg === "faqdef:rehearse") {
      args.command = args.command ?? "rehearse";
      continue;
    }
    if (arg === "--no-strict") {
      args.noStrict = true;
      continue;
    }
    if (arg === "--log") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, message: "error: --log requires a file path" };
      args.log = value;
      continue;
    }
    if (arg === "--count" || arg === "--budget") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        return { ok: false, message: `error: ${arg} requires an integer value` };
      }
      if (arg === "--count") args.count = Number.parseInt(value, 10);
      else args.budget = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--axes") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, message: "error: --axes requires a comma-separated list" };
      args.axes = value.split(",").map((a) => a.trim()).filter(Boolean);
      continue;
    }
    const flag = VALUE_FLAGS.find(([name]) => name === arg);
    if (flag) {
      const value = argv[++i];
      if (value === undefined) return { ok: false, message: `error: ${arg} requires a value` };
      (args[flag[1]] as string | undefined) = value;
      continue;
    }
    return { ok: false, message: `error: unknown flag ${arg}` };
  }
  return { ok: true, args };
}

//#region Subcommand bodies

export async function runGenerate(args: ParsedFaqdefArgs): Promise<{ exitCode: number; message?: string }> {
  if (!args.plan || !existsSync(args.plan)) {
    return { exitCode: 2, message: `error: generate requires --plan <existing file> (got ${args.plan ?? "none"})` };
  }
  if (!args.manifest || !existsSync(args.manifest)) {
    return { exitCode: 2, message: `error: generate requires --manifest <existing file> (got ${args.manifest ?? "none"})` };
  }
  const result = await generateFaqdefSheet({
    planPath: args.plan,
    manifestPath: args.manifest,
    disclosurePath: args.disclosure,
    profilePath: args.profile,
    configPath: args.config,
    outDir: args.out ?? join("docs", "qa"),
  });
  for (const f of result.outFiles) console.log(`[faqdef] wrote ${f}`);
  if (!result.ok) {
    return { exitCode: 1, message: result.message ?? "faqdef generation failed" };
  }
  if (result.mode === "fallback") {
    // FAQDEF-RES-01: degraded-but-successful path exits 0 by design.
    return { exitCode: 0 };
  }
  return { exitCode: 0 };
}

/** faqdef rehearse — strict-judge interactive loop (FAQDEF-04/05). */
async function runRehearse(args: ParsedFaqdefArgs): Promise<{ exitCode: number; message?: string }> {
  if (!args.qa) {
    return { exitCode: 2, message: "error: rehearse requires --qa <sheet file>" };
  }
  // Config defaults (subset size / budget) come from config/faqdef.json when
  // present; CLI flags win over config; env FAQDEF_BUDGET_S wins mid-event.
  let defaultSubsetSize: number | undefined;
  let defaultBudgetS: number | undefined;
  const configPath = args.config ?? join("config", "faqdef.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        rehearsal?: { per_question_budget_s?: number; default_subset_size?: number };
      };
      defaultSubsetSize = cfg.rehearsal?.default_subset_size;
      defaultBudgetS = cfg.rehearsal?.per_question_budget_s;
    } catch {
      /* malformed config → flag/env/§8.2 defaults apply (GOV-RES-02) */
    }
  }
  const envBudget = process.env["FAQDEF_BUDGET_S"];
  const budget = args.budget ?? (envBudget && /^\d+$/.test(envBudget) ? Number.parseInt(envBudget, 10) : undefined);
  const exitCode = await runRehearsal({
    qaPath: args.qa,
    count: args.count,
    budgetS: budget,
    axes: args.axes,
    strict: !args.noStrict,
    logPath: args.log,
    defaultSubsetSize,
    defaultBudgetS,
  });
  return { exitCode };
}

//#endregion

/** Map an npm script name (npm_lifecycle_event) to its §9.1 subcommand. */
function commandFromLifecycleEvent(event: string): "generate" | "rehearse" | undefined {
  if (event === "faqdef:rehearse") return "rehearse";
  if (event === "faqdef:generate" || event === "faqdef:gen") return "generate";
  return undefined;
}

/** Entry point — exported for tests; runs standalone under vite-node. */
export async function runFaqdefCli(argv: string[]): Promise<number> {
  const parsed = parseFaqdefArgs(argv);
  // `npm run faqdef:rehearse -- --qa …` passes no subcommand word in argv;
  // infer it from the npm lifecycle event so §9.1 aliases work verbatim.
  if (!parsed.args?.command && !parsed.args?.help) {
    const lifecycleCommand = commandFromLifecycleEvent(process.env["npm_lifecycle_event"] ?? "");
    if (lifecycleCommand && parsed.args) parsed.args.command = lifecycleCommand;
  }
  if (!parsed.ok || (!parsed.args?.help && !parsed.args?.command)) {
    console.error(USAGE);
    if (parsed.message) console.error(parsed.message);
    return 2;
  }
  if (parsed.args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const outcome =
      parsed.args.command === "rehearse"
        ? await runRehearse(parsed.args)
        : await runGenerate(parsed.args);
    if (outcome.message) console.error(outcome.message);
    return outcome.exitCode;
  } catch (err) {
    // GOV-RES-01 last line: typed failures are returned above; this catches
    // anything truly unexpected so the CLI never dies unhandled.
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
const invokedDirectly = argv1.endsWith("faqdef/cli.ts");
const invokedViaViteNode =
  argv1.includes("vite-node") &&
  process.env["CHASSIS_DISPATCH"] === undefined &&
  process.env["VITEST"] === undefined;
if (invokedDirectly || invokedViaViteNode) {
  runFaqdefCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
