// Requirement IDs: CTX-01, CTX-REU-02
// Adapters module entry (DP-E §3.3, §9.2): re-exports the registry API and
// registers the three built-in adapters. Import this module once for its
// registration side effect (it is also re-exported by src/context/index.ts).
import { registerAdapter } from "./types.js";
import { openaiChatAdapter } from "./openai.js";
import { anthropicMessagesAdapter } from "./anthropic.js";
import { genericAdapter } from "./generic.js";

export {
  registerAdapter,
  getAdapter,
  listAdapters,
} from "./types.js";
export type { ProviderAdapter } from "./types.js";
export { openaiChatAdapter } from "./openai.js";
export { anthropicMessagesAdapter } from "./anthropic.js";
export { genericAdapter } from "./generic.js";

let builtInsRegistered = false;

/** Idempotent registration of the three built-in adapters (mirrors strategies/index.ts). */
export function ensureBuiltInAdaptersRegistered(): void {
  if (builtInsRegistered) return;
  registerAdapter(openaiChatAdapter);
  registerAdapter(anthropicMessagesAdapter);
  registerAdapter(genericAdapter);
  builtInsRegistered = true;
}

ensureBuiltInAdaptersRegistered();
