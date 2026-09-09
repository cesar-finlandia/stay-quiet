// Requirement IDs: DEP-01, DEP-02, DEP-03, DEP-04, DEP-REU-01 | DP-B §5.1–§5.3
// Vercel adapter — the ONLY file (with its sibling adapters) allowed to know
// about the `vercel` CLI. Wraps a single command to public URL:
//   vercel --prod --confirm   (credentials from VERCEL_TOKEN/VERCEL_PROJECT_ID)
// Rollback: npx vercel rollback --project $VERCEL_PROJECT_ID --yes (DEP-03).
// No hardcoded tokens anywhere; failures propagate to runDeploy's fallback
// chain (GOV-RES-01 / DEP-RES-01).

export const providerId: string = "vercel";

import { spawnSync } from "node:child_process";
import type { DeployResult } from "../types.js";

function run(cmd: string[], label: string): void {
  const res = spawnSync(cmd[0] ?? "vercel", cmd.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (res.error) throw new Error(`${label}: could not spawn (${res.error.message})`);
  if ((res.status ?? 1) !== 0) throw new Error(`${label}: exit code ${res.status}`);
}

export async function deploy(): Promise<DeployResult> {
  const t0 = Date.now();
  console.log("[deploy:vercel] running single-command deploy → vercel --prod --confirm");
  // Flow A of DP-B §5.1 — one command; git-push hook (Flow B) is equivalent.
  run(["npx", "--yes", "vercel", "--prod", "--confirm"], "vercel --prod");
  const elapsedMs = Date.now() - t0;

  const url = process.env.PUBLIC_URL ?? "";
  if (!url) {
    // Vercel prints the URL on stdout above; export it as PUBLIC_URL for the
    // smoke step when not preset in .env.
    throw new Error(
      "deploy finished but PUBLIC_URL is unset — set it in .env to the printed production URL so deploy:verify can poll /health",
    );
  }
  console.log(`[deploy:vercel] public URL: ${url} (${elapsedMs}ms)`);
  return { url, provider: "vercel", elapsedMs };
}

/** DEP-03 — instant rollback to last successful deployment. */
export async function rollback(): Promise<void> {
  const project = process.env.VERCEL_PROJECT_ID ?? "";
  const args = ["--yes"];
  if (project) args.push("--project", project);
  console.log("[deploy:vercel] rolling back via npx vercel rollback");
  run(["npx", "--yes", "vercel", "rollback", ...args], "vercel rollback");
}
