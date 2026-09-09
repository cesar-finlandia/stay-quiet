// Requirement IDs: CTX-01, XCUT-08
// 'openai-chat' adapter (DP-E §3.3): OpenAI Chat Completions message shape.
// role system/user/assistant/tool maps 1:1 to {role, content}; `tool` maps to
// `assistant` with tool_call_id stripped — DOCUMENTED LOSSY (§3.5): the wire form
// cannot carry chassis `tool` role, so fromProvider() of such a message yields
// assistant and the original role is not recoverable. Shape conversion only:
// no token logic, no side effects; imports nothing outside src/context/types.js.
import type { Buffer, Message, Role } from "../types.js";
import type { ProviderAdapter } from "./types.js";

/** OpenAI Chat Completions wire entry (structural subset we rely on). */
type OpenAIWireMessage = { role: string; content: unknown; tool_call_id?: string };

const KNOWN_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

function toWireMessage(m: Message): OpenAIWireMessage {
  // 1:1 for system/user/assistant; tool → assistant with tool_call_id stripped (lossy §3.5).
  return m.role === "tool"
    ? { role: "assistant", content: m.content }
    : { role: m.role, content: m.content };
}

function fromWireEntry(w: unknown): Message | null {
  if (typeof w !== "object" || w === null) return null;
  const e = w as Record<string, unknown>;
  if (typeof e.role !== "string") return null;
  const rawRole = e.role.toLowerCase();
  const role: Role = KNOWN_ROLES.has(rawRole) ? (rawRole as Role) : "user";
  const content = typeof e.content === "string" ? e.content : "";
  // Preserve pinned via metadata convention (§3.5): wire has no metadata field,
  // so round-trips lose it unless the caller re-pins. Content/role are faithful.
  return { role, content };
}

export const openaiChatAdapter: ProviderAdapter = {
  id: "openai-chat",
  toProvider(buffer: Buffer): unknown {
    return buffer.map(toWireMessage);
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
