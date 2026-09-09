// Requirement IDs: DEP-REU-01 | DP-B §5.1 — Replit adapter. Provider detail
// lives here + config/deploy/replit.json only; app code never sees it.

export const providerId: string = "replit";

import { spawnSync } from "node:child_process";
import type { DeployResult } from "../types.js";

export async function deploy(): Promise<DeployResult> {
  const t0 = Date.now();
  console.log("[deploy:replit] running single-command deploy → replit deploy");
  const res = spawnSync("npx", ["--yes", "replit", "deploy"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (res.error || (res.status ?? 1) !== 0) {
    throw new Error(`replit deploy failed: ${res.error?.message ?? `exit ${res.status}`}`);
  }
  const url = process.env.PUBLIC_URL ?? "";
  if (!url) throw new Error("PUBLIC_URL unset — set it to the printed repl URL for deploy:verify");
  return { url, provider: "replit", elapsedMs: Date.now() - t0 };
}
