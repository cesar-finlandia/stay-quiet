// Requirement IDs: CTX-01, XCUT-08
// 'generic' adapter (DP-E §3.3): plain {role, content}[] passthrough — fallback for
// any OpenAI-compatible provider (Cohere, Mistral, local). Round-trip faithful for
// well-formed entries; unknown roles normalize to "user", malformed entries skipped.
// Preserves pinned via the metadata convention only in-memory (wire has no metadata
// slot; see §3.5). Shape conversion only; imports nothing outside src/context/types.js.
import type { Buffer, Message, Role } from "../types.js";
import type { ProviderAdapter } from "./types.js";

const KNOWN_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

function fromWireEntry(w: unknown): Message | null {
  if (typeof w !== "object" || w === null) return null;
  const e = w as Record<string, unknown>;
  if (typeof e.role !== "string") return null;
  const rawRole = e.role.toLowerCase();
  const role: Role = KNOWN_ROLES.has(rawRole) ? (rawRole as Role) : "user";
  const content = typeof e.content === "string" ? e.content : "";
  return { role, content };
}

export const genericAdapter: ProviderAdapter = {
  id: "generic",
  toProvider(buffer: Buffer): unknown {
    // Passthrough of the structural core only ({role, content}) — metadata is
    // chassis-side and intentionally not serialized onto the wire.
    return buffer.map((m) => ({ role: m.role, content: m.content }));
  },
  fromProvider(wire: unknown): Buffer {
    if (!Array.isArray(wire)) return [];
    const out: Buffer = [];
    for (const w of wire) {
      const m = fromWireEntry(w);
      if (m) out.push(m);
    }
    return out;
  },
  wireFormatExample: '[{"role":"system","content":"You are helpful."},{"role":"user","content":"hi"}]',
};
