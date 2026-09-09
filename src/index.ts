// Public TypeScript barrel for the parts of this repository the browser bundle uses.
// Only barrels that actually exist are re-exported; frontend code should prefer the
// concrete path (e.g. "src/platform/transport") so ownership stays obvious.
export * from "./platform/transport/index.js";
export * from "./platform/ui/index.js";
