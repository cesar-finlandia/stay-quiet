// Requirement IDs: RES-REU-01, RES-04, RES-01, RES-05, RES-06, XCUT-06, XCUT-08
// The ONLY curated public surface of the resilience layer (DP-A §9.1/§9.4).
//
// Consumers import exclusively from "src/resilience" — never from internal
// files (cache/store, config, wrapper internals). Deep imports are CI-blocked.
// Everything not listed here is an implementation detail and may change.
//
// Functions: withResilience, withResilienceSync, withValidation,
//            isDegradedResult, createGoldenCache, validate, repair
// Types:     DegradedResult, ResilienceConfig, GoldenCache, ValidationError

export { withResilience, withResilienceSync, withValidation } from "./wrapper.js";

export { isDegradedResult } from "./degraded.js";
export type { DegradedResult } from "./degraded.js";
// Additive (M06/DATA-04): consumers surface degraded results and render the
// GENERIC RES-04 repair prompt without duplicating either (DP-H §5.1).
export { makeDegradedResult } from "./degraded.js";

export type { ResilienceConfig } from "./config.js";

export type { GoldenCache } from "./cache/index.js";
export { createGoldenCache } from "./cache/index.js";

export { validate, repair, renderRepairPrompt } from "./validate.js";
export type { ValidationError } from "./validate.js";
