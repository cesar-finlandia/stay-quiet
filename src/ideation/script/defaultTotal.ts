// Requirement IDs: SCRIPT-01, PROFILE-05, GOV-RES-02 — DP-D2a §4.1/§6.6.
//
// Total-length precedence (lowest → highest), implemented exactly once here:
//   1. hardcoded fallback 3.0 minutes (lablab-safe when no limit is stated);
//   2. event_profile.json:video_limits.max_minutes when PROFILE ran and the
//      file validates against contracts/event-profile.schema.json — missing,
//      invalid, null or "not-extracted" markers are ignored with a warn;
//   3. explicit timing.yaml:total_minutes — always wins over the profile seed.
//
// The 3.0 fallback is the ONLY number allowed to live in src/ideation/script/
// outside fixtures/examples (SCRIPT-REU-02 CI guard); every section boundary
// comes from config.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../resilience/index.js";
import type { TimingConfig } from "./timing.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");

/** Hardcoded lablab-safe fallback total (minutes) — §4.1 precedence entry 1. */
export const FALLBACK_TOTAL_MINUTES = 3.0;

/** Minimal structural view of the profile fields SCRIPT reads (PROFILE-05). */
export interface EventProfileVideoLimits {
  max_minutes?: number | null | { status?: string };
}

export interface EventProfile {
  video_limits?: EventProfileVideoLimits;
}

/** Warn sink injectable for tests; defaults to console.warn. */
export type WarnFn = (message: string) => void;

let eventProfileSchemaCache: object | null = null;

function loadEventProfileSchema(): object {
  return (eventProfileSchemaCache ??= JSON.parse(
    readFileSync(join(REPO_ROOT, "contracts", "event-profile.schema.json"), "utf8"),
  ) as object);
}

/**
 * Extract video_limits.max_minutes per §4.1: numbers only — null, the
 * PROFILE-04 "not extracted" marker string/object, or any non-finite value
 * counts as absent (caller falls through to the next precedence entry).
 */
export function extractProfileMaxMinutes(profile: EventProfile | null | undefined): number | null {
  const raw = profile?.video_limits?.max_minutes;
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  return null; // marker object / wrong shape → treat as not stated
}

/**
 * resolveTotalMinutes(timing, profile) — §4.1 precedence, verbatim:
 * explicit timing.yaml total wins over the event_profile seed wins over the
 * hardcoded 3.0 fallback. Never throws.
 */
export function resolveTotalMinutes(
  timing: TimingConfig | null,
  profile: EventProfile | null,
): number {
  if (timing?.total_minutes != null) return timing.total_minutes;
  const fromProfile = extractProfileMaxMinutes(profile);
  if (fromProfile != null) return fromProfile;
  return FALLBACK_TOTAL_MINUTES;
}

/**
 * loadEventProfile(path|null) — optional advisory input (PROFILE-05).
 *
 * Missing file → { profile: null } silently (absence is normal). Present but
 * unreadable/unparseable/RES-04-invalid → ignored with the §6.6 warn
 * `event_profile.json invalid — using fallback 3 min total` and null returned;
 * unlike timing.yaml this is degrade-not-block because it only seeds the
 * default total.
 */
export function loadEventProfile(
  path: string | null | undefined,
  warn: WarnFn = (m) => console.warn(m),
): EventProfile | null {
  if (path == null || !path.trim()) return null;
  const resolved = path.trim();
  if (!existsSync(resolved)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolved, "utf8"));
    const result = validate(loadEventProfileSchema(), parsed);
    if (!result.valid || typeof parsed !== "object" || parsed === null) {
      warn("event_profile.json invalid — using fallback 3 min total");
      return null;
    }
    return parsed as EventProfile;
  } catch {
    warn("event_profile.json invalid — using fallback 3 min total");
    return null;
  }
}
