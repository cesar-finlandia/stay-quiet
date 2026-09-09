// Requirement IDs: RES-05, XCUT-08
// Manual golden-path population helper (DP-A §5.4, §11.3).
//
//   npx tsx src/resilience/scripts/record-golden.ts \
//     --provider acme --model widget-v1 \
//     --input examples/dummy-fixtures/resilience/sample-payload.explicit-key.json \
//     --output response.json [--key demo-step-acme-widget-overview] [--source manual]
//
// --input  : JSON file with the request/prompt object used for key derivation.
// --output : JSON file with the response payload to store in the cache.
// --key    : optional explicit kebab-case key (skips provider/model derivation).
// Writes via cache.put (atomic); prints the derived key + stored path.
// Domain-free (GOV-REU-02); node stdlib only (RES-REU-01).

import { readFileSync } from "node:fs";
import { createGoldenCache } from "../cache/index.js";

interface Args {
  provider?: string;
  model?: string;
  input?: string;
  output?: string;
  key?: string;
  source: string;
  cacheDir?: string;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = { source: "manual" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--provider": args.provider = value; i++; break;
      case "--model": args.model = value; i++; break;
      case "--input": args.input = value; i++; break;
      case "--output": args.output = value; i++; break;
      case "--key": args.key = value; i++; break;
      case "--source": args.source = value ?? "manual"; i++; break;
      case "--cache-dir": args.cacheDir = value; i++; break;
      default:
        console.error(`record-golden: unknown flag ${flag}`);
        return null;
    }
  }
  if (!args.input || !args.output) return null;
  if (!args.key && (!args.provider || !args.model)) return null;
  if (!["mock", "data", "manual"].includes(args.source)) return null;
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "usage: record-golden --provider <p> --model <m> --input <request.json> --output <response.json> [--key <kebab-explicit>] [--source mock|data|manual] [--cache-dir <dir>]",
    );
    process.exitCode = 2;
    return;
  }

  let prompt: unknown;
  let value: unknown;
  try {
    prompt = JSON.parse(readFileSync(args.input as string, "utf8"));
  } catch (err) {
    console.error(`record-golden: cannot read --input (${err instanceof Error ? err.message : String(err)})`);
    process.exitCode = 2;
    return;
  }
  try {
    value = JSON.parse(readFileSync(args.output as string, "utf8"));
  } catch (err) {
    console.error(`record-golden: cannot read --output (${err instanceof Error ? err.message : String(err)})`);
    process.exitCode = 2;
    return;
  }

  const cache = createGoldenCache(args.cacheDir);
  const key =
    args.key !== undefined
      ? cache.deriveKey({ explicitKey: args.key })
      : cache.deriveKey({ provider: args.provider as string, model: args.model as string, prompt });

  void cache
    .put(key, value, {
      provider: args.provider,
      model: args.model,
      source: args.source,
      ...(args.key !== undefined ? { explicit_key: args.key } : {}),
    })
    .then(() => cache.has(key))
    .then((stored) => {
      if (!stored) {
        console.error("record-golden: put did not persist entry (see [resilience] warn lines)");
        process.exitCode = 1;
        return;
      }
      console.log(`record-golden: recorded key ${key}${args.key ? ` (explicit: ${args.key})` : ""} — verify with cache.get`);
    })
    .catch((err: unknown) => {
      console.error(`record-golden: failed (${err instanceof Error ? err.message : String(err)})`);
      process.exitCode = 1;
    });
}

main();
