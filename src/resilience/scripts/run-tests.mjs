// Requirement IDs: RES-AC-01..04, RES-RES-02, GOV-MIN-04, XCUT-08
// Test runner for the resilience acceptance suite (M01 step 7, DP-A §10).
// Pipeline: (1) tsc -p tsconfig.test.json -> .tmp_emit/  (2) copy defaults.json
// next to the emitted config module so loadGlobalDefaults() finds it
// (3) node --test .tmp_emit/tests/resilience/  (4) contracts check.
// `--offline` (or NETWORK=disabled already set) runs children with
// NETWORK=disabled — the airplane-mode gate of DP-A §10.3. Cross-platform:
// pure node, no shell env-prefix needed on Windows.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, ".."); // src/resilience
const repoRoot = resolve(pkgRoot, "..", "..");
const emitDir = join(pkgRoot, ".tmp_emit");

const offline =
  process.argv.includes("--offline") || process.env["NETWORK"] === "disabled";

function step(name, cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: offline ? { ...process.env, NETWORK: "disabled" } : process.env,
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`[run-tests] step failed: ${name} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Fresh emit (keep tree small and stale-file-free).
rmSync(emitDir, { recursive: true, force: true });
step("tsc -p tsconfig.test.json", "npx", ["tsc", "-p", "tsconfig.test.json"]);

// 2. defaults.json is data, not TS — tsc does not copy it. Emitted under the
// package dir so ajv (src/resilience/node_modules) resolves for both trees.
mkdirSync(join(emitDir, "src", "resilience"), { recursive: true });
copyFileSync(
  join(pkgRoot, "defaults.json"),
  join(emitDir, "src", "resilience", "defaults.json"),
);

// 3. The acceptance suite itself. A glob is passed rather than the bare
// directory: the path contains a dot-segment (.tmp_emit) which some node --test
// versions refuse to scan as a directory argument.
const testArgs = [
  "--test",
  "--test-reporter=spec",
  join("src", "resilience", ".tmp_emit", "tests", "resilience", "*.test.js"),
];
if (offline) {
  // Only the offline-designated files under NETWORK=disabled (DP-A §10.2/§10.3):
  // AC-02 plus the guards suite; the remaining ACs run in the normal pass.
  testArgs.push(
    join("src", "resilience", ".tmp_emit", "tests", "resilience", "ac02_offline.test.js"),
    join("src", "resilience", ".tmp_emit", "tests", "resilience", "guards.test.js"),
  );
}
step("node --test", "node", testArgs);

// 4. Frozen-contract sanity (kept from steps 1–6).
step("check-contracts", "node", [join("src", "resilience", "scripts", "check-contracts.mjs")]);

console.log(`[run-tests] OK${offline ? " (NETWORK=disabled)" : ""}`);
