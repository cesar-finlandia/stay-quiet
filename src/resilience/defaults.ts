// Requirement IDs: RES-07, RES-AC-04, GOV-RES-02, XCUT-08
// Hardcoded in-memory mirror of src/resilience/defaults.json (DP-A §4.2).
// Used verbatim when defaults.json is missing/unreadable/corrupt so config
// resolution never throws and never blocks startup (DP-A §7.4, RES-RES-03).
// Keep this file byte-for-byte semantically identical to defaults.json.
//
// Domain-free by construction (GOV-REU-02). This module must stay dependency-
// free at runtime: it imports only types from ./config.js (erased at compile
// time), so there is no runtime import cycle with config.ts.
import type { EffectiveConfig } from "./config.js";

export const FALLBACK_DEFAULTS: EffectiveConfig = {
  timeout_ms: 15000,
  retries: 2,
  backoff: {
    policy: "exponential",
    base_ms: 250,
    factor: 2.0,
    max_ms: 5000,
    jitter: true,
  },
  fallback_chain: {
    order: ["cache", "replay", "none"],
    secondary_provider: { enabled: false },
    cache: { enabled: true },
    replay: { enabled: true },
    none: { enabled: true },
  },
  cache_key_strategy: "auto",
  // Not present in defaults.json by design (schema defines no default; only
  // meaningful when cache_key_strategy=="explicit"). Empty string = unset.
  cache_key_explicit: "",
  forced_degraded: false,
};
