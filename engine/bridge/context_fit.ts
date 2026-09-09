// StayQuiet — Node bridge to the pre-existing context buffer (blueprint row 17).
// Reads one JSON object from stdin: {"messages":[{"role","content"}], "maxTokens":900}
// Writes one JSON object to stdout: {"messages":[…], "dropped":N, "tokens":N}
// Exit 0 on success; on failure writes {"error":"…"} to stdout and exits 1.
// Invoked ONLY by src/stayquiet/context_bridge.py:fit_thread().
import { fit } from "src/context/index.js";

type Wire = { messages?: Array<{ role?: string; content?: string }>; maxTokens?: number };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function main(): void {
  readStdin()
    .then((raw) => {
      const input = JSON.parse(raw || "{}") as Wire;
      const maxTokens = Number.isFinite(input.maxTokens) ? Number(input.maxTokens) : 900;
      const buffer = (input.messages ?? []).map((m) => ({
        role: (m.role === "assistant" || m.role === "system" || m.role === "tool"
          ? m.role
          : "user") as "user" | "assistant" | "system" | "tool",
        content: typeof m.content === "string" ? m.content : "",
      }));
      const out = fit(buffer, {
        model_profile: "bedrock",
        context_window: maxTokens,
        reserved_output: 0,
        strategy: "sliding-window-pinned",
        warning_threshold: 0.8,
        critical_threshold: 0.95,
      });
      process.stdout.write(
        JSON.stringify({
          messages: out.buffer.map((m) => ({ role: m.role, content: m.content })),
          dropped: out.status.evicted_count,
          tokens: out.status.total_tokens,
        }),
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stdout.write(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      );
      process.exit(1);
    });
}

main();
