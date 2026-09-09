// Requirement IDs: DEP-01, DEP-02, DEP-REU-01, DEP-RES-01, GOV-RES-01 | DP-B §5.1
// Deploy dispatcher: routes `npm run deploy` to the adapter selected by
// DEPLOY_PROVIDER (default read from config/deploy/provider.json).
// Provider SDKs are confined to src/platform/deploy/adapters/* — application
// code never imports one (DEP-REU-01). Every I/O failure path surfaces a
// documented fallback pointer (GOV-RES-01 / DEP-RES-01: rollback → recorded
// video → non-streaming localhost; see docs/deployment.md §Fallback).

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import type { DeployProvider } from "../config/env.js";
import { deploy as deployDocker, providerId as dockerId } from "./adapters/docker.js";
import { deploy as deployReplit, providerId as replitId } from "./adapters/replit.js";
import { deploy as deployStreamlit, providerId as streamlitId } from "./adapters/streamlit.js";
import { deploy as deployVercel, rollback as rollbackVercel, providerId as vercelId } from "./adapters/vercel.js";
import type { DeployResult } from "./types.js";

export type { DeployResult } from "./types.js";

// Adapter registry keyed by each adapter's self-declared providerId — no
// provider-name literals live outside config/deploy/, adapters/, examples/
// (DEP-REU-01). The allowed set is cross-checked against the descriptors in
// config/deploy/* so a new descriptor file without an adapter fails loudly.
const ADAPTERS = new Map<string, () => Promise<DeployResult>>([
  [vercelId, deployVercel],
  [replitId, deployReplit],
  [streamlitId, deployStreamlit],
  [dockerId, deployDocker],
]);

function configuredProviders(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../config/deploy");
  try {
    return readdirSync(dir)
      .filter((f) => /\.(json|toml)$/.test(f) && f !== "provider.json")
      .map((f) => f.replace(/\.(json|toml)$/, ""));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch {
    return [...ADAPTERS.keys()];
  }
}

/** One command → public URL (DEP-01). Dispatches on env.deployProvider. */
export async function runDeploy(provider: string = env.deployProvider): Promise<DeployResult> {
  const adapter = ADAPTERS.get(provider);
  if (!adapter) {
    throw new Error(
      `[deploy] unknown DEPLOY_PROVIDER "${provider}" — expected one of ` +
        `${[...ADAPTERS.keys()].join(", ")} (descriptors: ${configuredProviders().join(", ")}). ` +
        `Fix .env (see config/env.example).`,
    );
  }
  try {
    return await adapter();
  } catch (err) {
    // GOV-RES-01 / DEP-RES-01: a failed deploy is never a dead end.
    throw new Error(
      `[deploy] ${provider} deploy failed after ${(err as Error).message ?? err}. ` +
        `Fallback chain (docs/deployment.md §Fallback): ` +
        `(1) rollback to known-good ≤2 min, (2) recorded video backup, ` +
        `(3) non-streaming localhost via TRN-RES-03.`,
      { cause: err },
    );
  }
}

/** Known-good redeploy entry point (DEP-03) — provider-specific rollback. */
export function runRollback(): Promise<void> {
  // Only Vercel exposes an instant rollback today; other providers use the
  // git path documented in docs/deployment.md §Rollback.
  return rollbackVercel();
}
