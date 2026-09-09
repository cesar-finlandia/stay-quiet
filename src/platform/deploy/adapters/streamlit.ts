// Requirement IDs: DEP-REU-01 | DP-B §5.1 — Streamlit Cloud adapter. Streamlit
// has no native SSE (TRN-03): set TRANSPORT=none per config/deploy/streamlit.toml.
// Deploys are driven through the Streamlit Cloud UI/CLI; this adapter validates
// the descriptor and prints the expected PUBLIC_URL handoff.

export const providerId: string = "streamlit";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DeployResult } from "../types.js";

export async function deploy(): Promise<DeployResult> {
  const t0 = Date.now();
  const cfgPath = fileURLToPath(new URL("../../../../config/deploy/streamlit.toml", import.meta.url));
  try {
    await readFile(cfgPath, "utf8");
  } catch {
    throw new Error(`streamlit.toml missing at ${cfgPath} — re-derive from config/deploy/README.md`);
  }
  console.log("[deploy:streamlit] descriptor OK; push to the Streamlit Cloud repo, then set PUBLIC_URL");
  const url = process.env.PUBLIC_URL ?? "";
  if (!url) throw new Error("PUBLIC_URL unset — set it to the streamlit app URL for deploy:verify");
  return { url, provider: "streamlit", elapsedMs: Date.now() - t0 };
}
