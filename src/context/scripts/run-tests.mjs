// Requirement IDs: CTX-AC-01..03, CTX-RES-01/02, GOV-MIN-04, XCUT-08
// Test runner for the context acceptance suite (M03 step 6, DP-E §10).
// Pipeline: (1) tsc -p tsconfig.context-test.json -> src/context/.tmp_emit/
// (2) node --test on the emitted *.test.js. Mirrors the resilience runner
// (src/resilience/scripts/run-tests.mjs). Cross-platform: pure node, no shell.
// A glob is passed rather than the bare directory: the path contains a
// dot-segment (.tmp_emit) which some `node --test` versions refuse to scan.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, ".."); // src/context
const repoRoot = resolve(pkgRoot, "..", "..");
const emitDir = join(pkgRoot, ".tmp_emit");

function step(name, cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, NETWORK: "disabled" }, // pure computation — offline by construction (DP-E §10)
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`[run-tests] step failed: ${name} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Fresh emit (keep tree small and stale-file-free).
rmSync(emitDir, { recursive: true, force: true });
step("tsc -p tsconfig.context-test.json", "npx", ["tsc", "-p", "tsconfig.context-test.json"]);

// 2. The acceptance + guard suites themselves. Quote the node executable: on
// Windows spawnSync(shell:true) splits paths containing spaces (C:\Program Files\...).
step(
  "node --test tests/context",
  process.platform === "win32" ? `"${process.execPath}"` : process.execPath,
  [
    "--test",
    "--test-reporter=spec",
    join("src", "context", ".tmp_emit", "tests", "context", "*.test.js"),
  ],
);
