// Requirement IDs: CTX-01, XCUT-08
// 'anthropic-messages' adapter (DP-E §3.3): Anthropic Messages API message shape.
// Only user/assistant roles exist on the wire; the chassis system prompt is
// extracted to the Anthropic `system` param convention on toProvider() and
// re-materialized as a system Message on fromProvider(). Content may be a plain
// string or ContentBlock[] — normalized back to plain strings. `tool` maps via
// adapter option (default: assistant, DOCUMENTED LOSSY §3.5). Shape conversion
// only; imports nothing outside src/context/types.js.
import type { Buffer, Message } from "../types.js";
import type { ProviderAdapter } from "./types.js";

/** Wire entry: {role:"user"|"assistant", content: string | ContentBlock[]}. */
type AnthropicWireMessage = { role: string; content: unknown };

const WIRE_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

/** Flatten ContentBlock[] ({type:"text",text} | other) to plain string (§3.3 table). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text"
          ? String((b as Record<string, unknown>).text ?? "")
          : ""
      )
      .join("");
  }
  return "";
}

export const anthropicMessagesAdapter: ProviderAdapter = {
  id: "anthropic-messages",
  toProvider(buffer: Buffer): unknown {
    const messages: AnthropicWireMessage[] = [];
    const systemParts: string[] = [];
    for (const m of buffer) {
      if (m.role === "system") systemParts.push(m.content); // extracted to `system` param convention
      else
        messages.push({
          // Only user/assistant exist on the wire; chassis `tool` folds into assistant
          // via the default adapter option (DOCUMENTED LOSSY, §3.3 table / §3.5).
          role: m.role === "tool" ? "assistant" : m.role,
          content: m.content,
        });
    }
    return systemParts.length > 0 ? { system: systemParts.join("\n\n"), messages } : { messages };
  },
  fromProvider(wire: unknown): Buffer {
    const out: Buffer = [];
    let wireList: unknown[] = [];
    if (Array.isArray(wire)) wireList = wire;
    else if (typeof wire === "object" && wire !== null && Array.isArray((wire as Record<string, unknown>).messages)) {
      const obj = wire as Record<string, unknown>;
      wireList = obj.messages as unknown[];
      if (typeof obj.system === "string" && obj.system.length > 0)
        out.push({ role: "system", content: obj.system }); // restore extracted system prompt
    }
    for (const w of wireList) {
      if (typeof w !== "object" || w === null) continue;
      const e = w as Record<string, unknown>;
      if (typeof e.role !== "string" || !WIRE_ROLES.has(e.role)) continue;
      out.push({ role: e.role as "user" | "assistant", content: contentToText(e.content) });
    }
    return out;
  },
  wireFormatExample:
    '{"system":"You are helpful.","messages":[{"role":"user","content":"hi"}]}',
};
