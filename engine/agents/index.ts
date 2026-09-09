// TODO(ENGINE): design agent graph topology — see docs/engine-guide.md (NONGOAL-02: no fixed Router→Specialist→Critic shape)
import { withResilience } from "src/resilience";

// TODO(ENGINE): implement your agent call — this wrapper is already demo-proof
export const callAgent = withResilience(
  async (input: unknown) => {
    // TODO(ENGINE): replace with real LLM/agent call
    throw new Error("ENGINE_TODO: agent not yet implemented");
  },
  { timeout_ms: 15000, retries: 1, fallback_chain: { order: ["cache", "none"] } },
);
