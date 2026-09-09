// Requirement IDs: CTX-01, CTX-REU-02
// Provider adapter interface + registry (DP-E §3.3). Adapters convert between the
// provider-agnostic Buffer and provider-specific wire formats. Shape conversion ONLY:
// no token logic, no side effects, no I/O (CTX-01). Pluggable via registerAdapter()
// without chassis edits (GOV-REU-02).
import type { Buffer } from "../types.js";

export interface ProviderAdapter {
  /** Stable id matching tokenizer-profiles.json key prefix, e.g. "openai-chat", "anthropic-messages", "generic". */
  readonly id: string;
  /** Buffer → provider wire format (e.g. OpenAI ChatCompletionMessageParam[]). */
  toProvider(buffer: Buffer): unknown;
  /** Provider wire format → Buffer (normalizes role names, preserves pinned via convention §3.5). */
  fromProvider(wire: unknown): Buffer;
  /** Optional: wire-format example hint for docs/diagnostics; not token counting. */
  readonly wireFormatExample?: string;
}

//#region Registry (GOV-REU-02 pluggable)

const registry = new Map<string, ProviderAdapter>();

/** Register an adapter; later registrations replace earlier ones with the same id. */
export function registerAdapter(adapter: ProviderAdapter): void {
  if (!adapter || typeof adapter.id !== "string" || adapter.id.length === 0) {
    throw new Error("registerAdapter(): adapter must have a non-empty string id");
  }
  registry.set(adapter.id, adapter);
}

/** Look up by id; null when unknown (never throws — GOV-RES-04 style). */
export function getAdapter(id: string): ProviderAdapter | null {
  return registry.get(id) ?? null;
}

/** Stable-order list of registered adapter ids. */
export function listAdapters(): string[] {
  return [...registry.keys()];
}

//#endregion
