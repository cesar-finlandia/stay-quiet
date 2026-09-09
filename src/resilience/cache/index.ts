// Requirement IDs: RES-05, XCUT-08
// Public entry point of the golden-path cache subpackage (DP-A §9.2).
// Re-exports the GoldenCache factory + types; internals stay behind this barrel.
import type { GoldenCache, IndexEntry, ListEntry, PutMeta, CacheSource } from "./store.js";
export { createGoldenCache, deriveKeyStandalone as deriveKey, stableJsonStringify, setCacheWarnLogger, REPLAY_PREFIX, INDEX_VERSION } from "./store.js";
export type { GoldenCache, IndexEntry, ListEntry, PutMeta, CacheSource };
