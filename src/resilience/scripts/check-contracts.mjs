#!/usr/bin/env node
// Requirement IDs: RES-04, RES-06, RES-07, GOV-MIN-04, XCUT-08
// M01 step-1 scaffold smoke check backing the `test` / `test:offline` scripts.
// Dependency-free (GOV-MIN-04), zero network: asserts that every frozen contract
// under contracts/ parses as strict JSON. Replaced by the real TS/Python suites
// when wrapper/config/cache code lands in later steps of DP-A.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, "..", "..", "..", "contracts");
const files = [
  "degraded-result.schema.json",
  "validation-error.schema.json",
  "resilience-config.schema.json",
];

let failed = false;
for (const file of files) {
  try {
    JSON.parse(readFileSync(join(contractsDir, file), "utf8"));
    console.log(`ok   contracts/${file}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL contracts/${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed) process.exit(1);
console.log("resilience scaffold smoke check passed (contracts parse as strict JSON)");
