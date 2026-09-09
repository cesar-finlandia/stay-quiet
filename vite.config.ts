// Requirement IDs: UI-03, UI-AC-02 | DP-B §6.3, §10.8 item 1
// Vite config for the minimal UI dev shell (`npm run dev`). Vitest keeps using
// vitest.config.ts (which takes priority when both exist); aliases here mirror
// it so components resolve identically in dev/build.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      src: `${root}src`,
      examples: `${root}examples`,
    },
  },
});
