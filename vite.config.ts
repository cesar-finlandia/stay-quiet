// Vite config for the StayQuiet single-page app.
// - `src` and `examples` aliases match the TypeScript paths in tsconfig.json.
// - No node-builtin alias is needed or wanted: nothing this app imports at runtime
//   reaches src/platform/transport, so node:fs / node:crypto / node:http never enter
//   the graph. If a build ever reports "Could not resolve node:…", the cause is a new
//   runtime import from that directory — remove it rather than aliasing around it.
// - The dev server proxies the API and the event stream to the Python service on
//   8080, so `npm run dev` and the deployed container behave identically.
// - The build writes to dist/, which src/stayquiet/api.py serves.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const API = "http://127.0.0.1:8080";

export default defineConfig({
  resolve: {
    alias: {
      src: `${root}src`,
      examples: `${root}examples`,
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/events": { target: API, changeOrigin: true, ws: false },
      "/healthz": { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
