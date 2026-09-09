// Requirement IDs: DATA-RES-01, RES-REU-02
// Provider-agnostic call abstraction — DP-H §6.4. Thin adapter seam: generate.ts
// never branches on a provider name; a new provider is a new adapter + a config
// edit in the shared config/model-profiles.json (PGM-11), not a code change.
// Optional built-in adapters (src/data/adapters/*) are NOT part of this step.
//
// The module holds exactly one configured ProviderCall; callProvider throws only
// when setProviderCall was never invoked ("DATA provider not configured") — all
// other failures surface through the RES-01 wrapper as DegradedResult.

/** Minimal provider seam (RES-REU-02): prompt in, raw model string out. */
export type ProviderCall = (prompt: string, model_profile: string) => Promise<string>;

let providerCall: ProviderCall | null = null;

/** Register the process-wide provider call (tests inject a mock; prod an adapter). */
export function setProviderCall(fn: ProviderCall): void {
  providerCall = fn;
}

/**
 * Invoke the configured provider. Throws ONLY when never configured —
 * generation paths wrap this in withResilience, so provider failures degrade
 * instead of escaping (GOV-RES-01 / DATA-RES-01).
 */
export function callProvider(prompt: string, model_profile: string): Promise<string> {
  if (!providerCall) throw new Error("DATA provider not configured");
  return providerCall(prompt, model_profile);
}
