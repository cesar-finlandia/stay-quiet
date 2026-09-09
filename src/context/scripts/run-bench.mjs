// Requirement IDs: CTX-RES-04, BENCH-03 | Bench runner for token-counting
// overhead (M03 step 6). Compiles the shared test emit if missing, then runs
// scripts/bench-token-overhead.js which writes reports/bench/token-overhead.json.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`[run-bench] step failed: ${name} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

if (!existsSync(join(emitDir, "scripts", "bench-token-overhead.js"))) {
  step("tsc -p tsconfig.context-test.json", "npx", ["tsc", "-p", "tsconfig.context-test.json"]);
}
step(
  "bench-token-overhead",
  process.platform === "win32" ? `"${process.execPath}"` : process.execPath,
  [join("src", "context", ".tmp_emit", "scripts", "bench-token-overhead.js")],
);
