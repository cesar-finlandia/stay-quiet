// Requirement IDs: DEMODRIVE-01, DEMODRIVE-02, DEMODRIVE-04, DEMODRIVE-05,
// GOV-RES-01, XCUT-06, XCUT-08 | Owned by M14 step 3 (DP-D2b §8.1/§9.1).
// CLI surface (§9.1):
//   demodrive capture --script <file> [--data-source mock|cache] [--out dir]
//                     [--layout single-focus|dashboard] [--validate] [--fast]
//                     [--full-page] [--cache-key <key>] [--config <file>]
//   demodrive validate --script <file>          # dry run, no browser
// Env: DEMODRIVE_BASE_URL overrides script.base_url (§8.1 .env row).
// Exit codes: 0 ok · 1 named failure (validation/preflight/step) · 2 usage.

import { loadDemodriveScript, applyConfigDefaults } from "./script.js";
import { runCapture, type CaptureOptions } from "./driver.js";
import { DemodrivePreflightFailed, DemodriveStepFailed } from "./errors.js";

export const USAGE = `usage:
  demodrive capture --script <file> [--data-source mock|cache] [--out <dir>]
                    [--layout single-focus|dashboard] [--validate] [--fast]
                    [--full-page] [--cache-key <key>] [--config <file>]
  demodrive validate --script <file>

options:
  --script <file>        required: click-sequence JSON (contracts/demodrive-script.schema.json)
  --data-source <kind>   mock = MOCK-01 publisher feed; cache = RES-05 golden cache (default: mock)
  --out <dir>            output root (default assets/demodrive); timestamp subfolder inside
  --layout <mode>        single-focus (UI-06 default) or dashboard
  --validate             validate script + config only, no browser
  --fast                 emit mock envelopes back-to-back (MOCK realtime:false)
  --full-page            fullPage boundary/intra-step screenshots
  --cache-key <key>      explicit RES-05 key when --data-source cache
  -h, --help             show this help and exit`;

export interface ParsedDemodriveArgs {
  command?: "capture" | "validate";
  script?: string;
  dataSource?: "mock" | "cache";
  out?: string;
  layout?: "single-focus" | "dashboard";
  validateOnly?: boolean;
  fast?: boolean;
  fullPage?: boolean;
  cacheKey?: string;
  configPath?: string;
  help?: boolean;
}

const VALUE_FLAGS: Record<string, keyof ParsedDemodriveArgs> = {
  "--script": "script",
  "--data-source": "dataSource",
  "--out": "out",
  "--layout": "layout",
  "--cache-key": "cacheKey",
  "--config": "configPath",
};

/** Pure arg parsing — unit-testable without process side effects. */
export function parseDemodriveArgs(argv: string[]): { ok: boolean; args?: ParsedDemodriveArgs; message?: string } {
  const args: ParsedDemodriveArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "capture" || arg === "validate") {
      args.command = args.command ?? arg;
      continue;
    }
    if (arg === "--validate") {
      args.validateOnly = true;
      continue;
    }
    if (arg === "--fast") {
      args.fast = true;
      continue;
    }
    if (arg === "--full-page") {
      args.fullPage = true;
      continue;
    }
    const valueKey = VALUE_FLAGS[arg];
    if (valueKey) {
      const value = argv[++i];
      if (value === undefined) return { ok: false, message: `error: ${arg} requires a value` };
      if (valueKey === "dataSource") {
        if (value !== "mock" && value !== "cache") {
          return { ok: false, message: `error: --data-source must be mock|cache (got ${value})` };
        }
        args.dataSource = value;
      } else if (valueKey === "layout") {
        if (value !== "single-focus" && value !== "dashboard") {
          return { ok: false, message: `error: --layout must be single-focus|dashboard (got ${value})` };
        }
        args.layout = value;
      } else {
        // script / out / cacheKey / configPath
        (args[valueKey] as string | undefined) = value;
      }
      continue;
    }
    return { ok: false, message: `error: unknown flag ${arg}` };
  }
  return { ok: true, args };
}

//#region Subcommand bodies

export interface CliOutcome {
  exitCode: number;
  message?: string;
}

/** demodrive validate — RES-04 dry run, no browser launched. */
export function validateScript(scriptPath: string | undefined): CliOutcome {
  if (!scriptPath) {
    return { exitCode: 2, message: "error: validate requires --script <file>" };
  }
  const res = loadDemodriveScript(scriptPath);
  if (!res.ok) {
    const detail = res.errors.map((e) => `${e.path}: [${e.code}] ${e.message}`).join("; ");
    return { exitCode: 1, message: `demodrive script validation failed — ${detail}` };
  }
  // Config is validated too when present (warn + defaults on failure).
  const { warned } = applyConfigDefaults();
  if (warned) console.warn(warned);
  console.log(`[demodrive] OK — ${res.script.steps.length} step(s) valid against contracts/demodrive-script.schema.json`);
  return { exitCode: 0 };
}

/** demodrive capture — feeder + headless Chromium capture run. */
export async function captureScript(args: ParsedDemodriveArgs): Promise<CliOutcome> {
  if (!args.script) {
    return { exitCode: 2, message: "error: capture requires --script <file>" };
  }
  if (args.validateOnly) return validateScript(args.script);

  const opts: CaptureOptions = {
    scriptPath: args.script,
    dataSource: args.dataSource,
    outRoot: args.out,
    layout: args.layout,
    configPath: args.configPath,
    fast: args.fast,
    fullPage: args.fullPage,
    cacheKey: args.cacheKey,
  };

  // DEMODRIVE_BASE_URL override is applied inside runCapture (driver.ts).

  const result = await runCapture(opts);
  if (result.ok) {
    console.log(`[demodrive] capture complete → ${result.runRoot}`);
    return { exitCode: 0 };
  }

  const name = result.error?.name ?? "Error";
  const message = result.error?.message ?? "unknown failure";
  if (name === "ValidationError") {
    return { exitCode: 1, message: `demodrive script validation failed — ${message}` };
  }
  if (name === "DemodrivePreflightFailed") {
    return { exitCode: 1, message };
  }
  if (name === "DemodriveStepFailed") {
    return { exitCode: 1, message }; // prior assets preserved; sentinel written
  }
  return { exitCode: 1, message };
}

//#endregion

/** Entry point — exported for tests; runs standalone under vite-node. */
export async function runDemodriveCli(argv: string[]): Promise<number> {
  const parsed = parseDemodriveArgs(argv);
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
      parsed.args.command === "validate"
        ? validateScript(parsed.args.script)
        : await captureScript(parsed.args);
    if (outcome.message) console.error(outcome.message);
    return outcome.exitCode;
  } catch (err) {
    // GOV-RES-01 last line: typed failures are returned above; this catches
    // anything truly unexpected so the CLI never dies unhandled.
    if (err instanceof DemodriveStepFailed || err instanceof DemodrivePreflightFailed) {
      console.error(err.message);
      return 1;
    }
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

// Entry detection mirrors src/dev/mock/cli.ts: plain node vs vite-node (whose
// argv[1] is vite-node's own cli.mjs). Skipped under vitest so imports stay inert.
const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
const invokedDirectly = argv1.endsWith("demodrive/cli.ts");
const invokedViaViteNode =
  argv1.includes("vite-node") &&
  process.env["CHASSIS_DISPATCH"] === undefined &&
  process.env["VITEST"] === undefined;
if (invokedDirectly || invokedViaViteNode) {
  runDemodriveCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
