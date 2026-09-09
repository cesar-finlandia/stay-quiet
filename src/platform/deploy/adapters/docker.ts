// Requirement IDs: DEP-REU-01 | DP-B §5.1 — Docker adapter (docker build + push
// per DOCKER_REGISTRY env; registry never hardcoded, DEP-REU-01/02).

export const providerId: string = "docker";

import { spawnSync } from "node:child_process";
import type { DeployResult } from "../types.js";

function run(cmd: string[], label: string): void {
  const res = spawnSync(cmd[0] ?? "docker", cmd.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (res.error || (res.status ?? 1) !== 0) {
    throw new Error(`${label} failed: ${res.error?.message ?? `exit ${res.status}`}`);
  }
}

export async function deploy(): Promise<DeployResult> {
  const t0 = Date.now();
  const registry = process.env.DOCKER_REGISTRY ?? "";
  if (!registry) throw new Error("DOCKER_REGISTRY unset — add it to .env (see config/deploy/docker.json)");
  const tag = `${registry}:latest`;
  console.log(`[deploy:docker] building and pushing ${tag}`);
  run(["docker", "build", "-t", tag, "."], "docker build");
  run(["docker", "push", tag], "docker push");
  const url = process.env.PUBLIC_URL ?? "";
  if (!url) throw new Error("PUBLIC_URL unset — set it to the hosted container URL for deploy:verify");
  return { url, provider: "docker", elapsedMs: Date.now() - t0 };
}
