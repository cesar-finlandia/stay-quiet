// Requirement IDs: DEP-01, DEP-04 | DP-B §5.1 — shared adapter result shape.
// PUBLIC_URL of the deployed app is what scripts/smoke-deploy.ts polls.

export interface DeployResult {
  /** Public base URL of the deployment (DEP-01 output; feeds PUBLIC_URL). */
  url: string;
  /** Adapter that produced the deployment (echoes DEPLOY_PROVIDER). */
  provider: string;
  /** Wall-clock deploy duration in ms (DEP-04 budget observation input). */
  elapsedMs: number;
}
