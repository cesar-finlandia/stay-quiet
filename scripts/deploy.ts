// Requirement IDs: DEP-01, DEP-REU-01, DEP-RES-01 | DP-B §5.1 — CLI entry for
// `npm run deploy`. Thin wrapper: dispatch + provider selection live in
// src/platform/deploy/deploy.ts; this file only wires process exit codes.
//
// Run: node scripts/deploy.ts   (npm script: `deploy`)

import { runDeploy } from "../src/platform/deploy/deploy.js";

try {
  const result = await runDeploy();
  console.log(`[deploy] OK ${result.provider} ${result.url} in ${result.elapsedMs}ms`);
  console.log("[deploy] next: npm run deploy:verify  (polls $PUBLIC_URL/health, DEP-04)");
} catch (err) {
  console.error(`[deploy] FAILED: ${(err as Error).message}`);
  console.error("[deploy] fallback chain: docs/deployment.md §Fallback (rollback → video → localhost)");
  process.exitCode = 1;
}
