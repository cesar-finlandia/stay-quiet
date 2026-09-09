// Requirement IDs: DEMODRIVE-05, DEMODRIVE-RES-01, GOV-RES-01, XCUT-08 | Owned by M14 step 2 (DP-D2b §3.6/§4.1)
// Output folder/naming for DEMODRIVE captures + atomic write helpers and the
// failure sentinel. Predictable structure keyed by step name + timestamp so an
// external editor imports `assets/demodrive/<timestamp>/` without renaming:
//
//   assets/demodrive/<YYYYMMDD-HHmmss>/
//     video.webm                    # context-level continuous recording
//     <step-id>/screenshot.png      # boundary screenshot after wait_after_ms
//     <step-id>/video.webm          # convenience copy/symlink -> ../video.webm
//     <step-id>/actions/001-<action>-<selector-slug>.png   # intra-step shots
//   demodrive-error.json            # DEMODRIVE-RES-01 sentinel on failure
//
// Capture only — no trimming/transcoding/editing of any artifact (NONGOAL-14).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DemodriveScript, DemodriveStep } from "./script.js";

/** Sentinel shape written as demodrive-error.json (DP-D2b §4.1). */
export interface DemodriveStepFailure {
  failed_step: string;
  step_index: number;
  action_index: number;
  selector: string | null;
  reason: string;
  interrupted?: boolean;
}

export const DEMODRIVE_ERROR_FILENAME = "demodrive-error.json";

//#region Naming helpers

/** UTC `YYYYMMDD-HHmmss` capture-folder stamp (DEMODRIVE-05). */
export function captureTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Filesystem-safe slug for a selector used in intra-step screenshot names. */
export function selectorSlug(selector: string | null | undefined): string {
  if (!selector) return "no-selector";
  return (
    selector
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "selector"
  );
}

/** `001-click-marketplace-list.png` style name for an intra-step screenshot. */
export function intraStepShotName(
  ordinal: number,
  action: string,
  selector?: string | null,
): string {
  const pad = String(ordinal).padStart(3, "0");
  return `${pad}-${action}-${selectorSlug(selector)}.png`;
}

//#endregion

//#region Run layout

export interface StepDirPlan {
  id: string;
  dir: string;
  screenshotPath: string;
  videoPath: string;
  actionsDir: string;
}

export interface RunLayout {
  runRoot: string;
  rootVideoPath: string;
  steps: StepDirPlan[];
}

/** DEMODRIVE-05 — create `outRoot/<timestamp>/<step-id>/` (+ actions/) for every
 * step in script order. Directories exist before capture starts so a mid-run
 * failure still leaves a predictable tree (DEMODRIVE-RES-01). */
export function createRunLayout(
  script: DemodriveScript,
  outRoot: string,
  now: Date = new Date(),
): RunLayout {
  const runRoot = resolve(join(resolve(outRoot), captureTimestamp(now)));
  mkdirSync(runRoot, { recursive: true });
  const steps: StepDirPlan[] = script.steps.map((step: DemodriveStep) => {
    const dir = join(runRoot, step.id);
    const actionsDir = join(dir, "actions");
    mkdirSync(actionsDir, { recursive: true });
    return {
      id: step.id,
      dir,
      screenshotPath: join(dir, "screenshot.png"),
      videoPath: join(dir, "video.webm"),
      actionsDir,
    };
  });
  return { runRoot, rootVideoPath: join(runRoot, "video.webm"), steps };
}

/** Convenience per-step video link (§3.6): symlink to the context-level file,
 * falling back to a copy where symlinks are unavailable (e.g. Windows without
 * privileges). Best-effort — never fatal. */
export function linkStepVideo(stepVideoPath: string, rootVideoPath: string): void {
  if (!existsSync(rootVideoPath)) return; // finalized later on context.close()
  try {
    unlinkSync(stepVideoPath);
  } catch {
    /* absent already */
  }
  try {
    symlinkSync(rootVideoPath, stepVideoPath);
  } catch {
    try {
      copyFileSync(rootVideoPath, stepVideoPath);
    } catch {
      /* editor convenience only — never fail the run over this */
    }
  }
}

//#endregion

//#region Atomic writes + failure sentinel

/** Write tmp + rename so no observer ever sees a partial artifact. */
export function writeTextAtomically(targetPath: string, text: string): string {
  const out = resolve(targetPath);
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.demodrive-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, out);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return out;
}

export function writeJsonAtomically(targetPath: string, data: unknown): string {
  return writeTextAtomically(targetPath, `${JSON.stringify(data, null, 2)}\n`);
}

/** DEMODRIVE-RES-01 sentinel — names the failed step/action and preserves the
 * already-captured assets for the operator. Written next to the run output. */
export function writeErrorSentinel(
  directory: string,
  failure: DemodriveStepFailure,
): string {
  return writeJsonAtomically(join(directory, DEMODRIVE_ERROR_FILENAME), failure);
}

/** Playwright writes the context recording as `<uuid>.webm` inside the video
 * dir; §3.6 requires it AT `video.webm`. Renames the newest root-level webm
 * atomically, then (re)creates the per-step convenience links — safe to call
 * after both success and failure finalization (RES-01: file is never partial). */
export function finalizeRunVideo(layoutPlan: RunLayout): string | null {
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(layoutPlan.runRoot)) {
      if (!name.endsWith(".webm")) continue;
      const full = join(layoutPlan.runRoot, name);
      if (!statSync(full).isFile()) continue;
      const mtime = statSync(full).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
    }
  } catch {
    return null;
  }
  if (!newest || existsSync(layoutPlan.rootVideoPath)) return layoutPlan.rootVideoPath;
  try {
    renameSync(newest.path, layoutPlan.rootVideoPath);
  } catch {
    return null; // best-effort; the raw webm still exists for the editor
  }
  for (const step of layoutPlan.steps) {
    linkStepVideo(step.videoPath, layoutPlan.rootVideoPath);
  }
  return layoutPlan.rootVideoPath;
}

//#endregion
