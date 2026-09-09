// Requirement IDs: DEMODRIVE-03, DEMODRIVE-04, DEMODRIVE-REU-02, XCUT-08
// Owned by M14 step 3 (DP-D2b §3.2 action semantics / §3.5 capture outputs).
// Executes one script step against a Playwright Page. Selectors pass through
// verbatim (role / testId / CSS) — theme-resilient per DEMODRIVE-REU-02; the
// driver never synthesizes a selector or auto-discovers a screen (§4.3).
//
// The `DemodrivePage` structural surface is the subset of playwright.Page the
// executor needs, so unit tests can stub it without launching a browser.

import { writeJsonAtomically, intraStepShotName } from "./output.js";
import { join } from "node:path";
import type { DemodriveAction, DemodriveScript, DemodriveStep } from "./script.js";

/** Structural subset of playwright.Page used by executeStep/runCaptureLoop.
 * getByRole/getByText are optional so unit-test stubs can omit them. */
export interface LocatorHandle {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}
export interface DemodrivePage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): LocatorHandle;
  getByRole?(role: string, options?: { name?: string }): LocatorHandle;
  getByText?(text: string): LocatorHandle;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

/** §3.2 selector guidance: author-supplied selectors arrive as role-style
 * (`getByRole('button', {name: '…'})`), test-id/css, or `text=` strings. Role
 * and text styles map onto the corresponding Page APIs; everything else passes
 * through verbatim to page.locator(). Theme-resilient by contract
 * (DEMODRIVE-REU-02); the driver adds no selectors of its own. */
export function resolveLocator(page: DemodrivePage, selector: string): LocatorHandle {
  const role = /^getByRole\(\s*['"]([\w]+)['"]\s*(?:,\s*\{([\s\S]*)\})?\s*\)$/.exec(selector);
  if (role && typeof page.getByRole === "function") {
    const name = role[2] ? (/name:\s*['"]([^'"]+)['"]/.exec(role[2])?.[1] ?? undefined) : undefined;
    return page.getByRole(role[1]!, name ? { name } : {});
  }
  if (selector.startsWith("text=") && typeof page.getByText === "function") {
    return page.getByText(selector.slice(5));
  }
  return page.locator(selector);
}

export interface StepOutcome {
  stepId: string;
  screenshotPath: string;
  intraStepShots: string[];
}

function timeoutOf(action: DemodriveAction, fallbackMs: number): number {
  return action.timeout_ms ?? fallbackMs;
}

async function assertVisible(
  page: DemodrivePage,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  await resolveLocator(page, selector).waitFor({ state: "visible", timeout: timeoutMs });
}

/** Execute every action of one step in order (§3.2 semantics). Throws on the
 * first failing action — the caller owns failure handling (DEMODRIVE-RES-01). */
export async function executeStep(args: {
  page: DemodrivePage;
  script: DemodriveScript;
  step: DemodriveStep;
  stepDir: string;
  actionsDir: string;
  defaultTimeoutMs: number;
  fullPage: boolean;
}): Promise<StepOutcome> {
  const { page, script, step, actionsDir, defaultTimeoutMs } = args;
  let shotOrdinal = 0;
  const intraStepShots: string[] = [];

  for (let i = 0; i < step.actions.length; i++) {
    const action = step.actions[i]!;
    const timeout = timeoutOf(action, defaultTimeoutMs);
    switch (action.action) {
      case "navigate": {
        // navigate → page.goto(value ?? base_url); §3.2: a RELATIVE value is
        // resolved against base_url so scripts can target in-app routes ("/").
        const raw = action.value ?? "";
        const target =
          raw === "" ? script.base_url
          : /^https?:\/\//i.test(raw) ? raw
          : new URL(raw, script.base_url).toString();
        await page.goto(target, { timeout });
        break;
      }
      case "click": {
        if (!action.selector) throw new Error("click action requires a selector");
        if (action.assert_visible ?? true) await assertVisible(page, action.selector, timeout);
        await resolveLocator(page, action.selector).click({ timeout });
        break;
      }
      case "fill": {
        if (!action.selector) throw new Error("fill action requires a selector");
        if (action.assert_visible ?? true) await assertVisible(page, action.selector, timeout);
        await resolveLocator(page, action.selector).fill(action.value ?? "", { timeout });
        break;
      }
      case "wait_for": {
        if (!action.selector) throw new Error("wait_for action requires a selector");
        await resolveLocator(page, action.selector).waitFor({ timeout });
        break;
      }
      case "wait_ms": {
        // wait_ms → authoritative pacing between intra-step actions.
        const ms = Number.parseInt(action.value ?? "0", 10);
        if (!Number.isNaN(ms) && ms > 0) await page.waitForTimeout(ms);
        break;
      }
      case "screenshot": {
        shotOrdinal += 1;
        const path = join(actionsDir, intraStepShotName(shotOrdinal, action.action, action.selector));
        await page.screenshot({ path, fullPage: args.fullPage });
        intraStepShots.push(path);
        break;
      }
      default: {
        throw new Error(`unsupported action "${String((action as { action?: string }).action)}"`);
      }
    }
  }

  return {
    stepId: step.id,
    screenshotPath: "", // filled by runCaptureLoop after wait_after_ms boundary shot
    intraStepShots,
  };
}

/** Boundary close-out for one step: wait_after_ms pause, then the mandatory
 * `<step>/screenshot.png` (fullPage only when --full-page). DEMODRIVE-03:
 * both video and this boundary screenshot are always produced. */
export async function finishStepBoundary(args: {
  page: DemodrivePage;
  step: DemodriveStep;
  defaultWaitAfterMs: number;
  screenshotPath: string;
  fullPage: boolean;
}): Promise<string> {
  const waitAfter = args.step.wait_after_ms ?? args.defaultWaitAfterMs;
  if (waitAfter > 0) await args.page.waitForTimeout(waitAfter);
  await args.page.screenshot({ path: args.screenshotPath, fullPage: args.fullPage });
  return args.screenshotPath;
}

/** JSON sidecar written next to each step's assets listing its artifacts
 * (editor convenience; atomic). Not required by DEMODRIVE-05 but stable. */
export async function writeStepManifest(stepDir: string, outcome: StepOutcome): Promise<string> {
  return writeJsonAtomically(join(stepDir, "step.manifest.json"), {
    id: outcome.stepId,
    screenshot: "screenshot.png",
    intra_step_screenshots: outcome.intraStepShots.map((p) => p.split(/[\\/]/).pop()),
  });
}
