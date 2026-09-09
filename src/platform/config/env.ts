// Requirement IDs: DEP-02, GOV-RES-02, DEP-AC-01 | DP-B §5.2, §8
// SINGLE config surface: this is the ONLY file in the chassis that reads
// process.env / import.meta.env (DP-B §5.2). All other modules import `env`.
//
// LLM keys are deliberately NOT part of this object and are never defaulted:
// a missing key must lead to degraded behavior elsewhere (RES-05 / GOV-RES-02),
// never to a crash at import time. Secrets never live in code or fixtures.
//
// Values are non-secret runtime knobs; secrets (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, TRACE_ID_SALT, VERCEL_TOKEN, VERCEL_PROJECT_ID) are read
// by tooling from the environment / .env filled from config/env.example only.

export type DeployProvider = "vercel" | "replit" | "streamlit" | "docker";
export type TransportKind = "sse" | "websocket" | "none";
export type ThemeName = "minimal" | "editorial" | "operator";

function fromNodeEnv(key: string): string | undefined {
  // Guarded access: process exists in Node and bundler-shimmed browsers;
  // import.meta.env is consulted first when present (Vite builds).
  const meta = (import.meta as { env?: Record<string, string | undefined> }).env;
  if (meta && typeof meta[key] === "string") return meta[key];
  if (typeof process !== "undefined" && process.env) return process.env[key];
  return undefined;
}

export const env = {
  /** DEP-01 / DEP-REU-01 — selects adapter under src/platform/deploy/adapters/. */
  deployProvider: (fromNodeEnv("DEPLOY_PROVIDER") ?? "vercel") as DeployProvider,
  /** TRN-03 — streaming transport choice; safe default keeps UI functional. */
  transport: (fromNodeEnv("TRANSPORT") ?? "sse") as TransportKind,
  /** UI-03 — theme token consumed by the component library. */
  theme: (fromNodeEnv("THEME") ?? "minimal") as ThemeName,
  /** API base for the frontend; empty = same-origin relative URLs. */
  apiBase: fromNodeEnv("API_BASE") ?? "",
} as const;

export type Env = typeof env;

/** PUBLIC_URL — deploy output location used by scripts/smoke-deploy.ts (§8). */
export function publicUrl(): string {
  return (
    fromNodeEnv("PUBLIC_URL") ??
    // Local fallback mirrors tests/platform/dep_ac01.test.ts default target.
    "http://localhost:3000"
  );
}
