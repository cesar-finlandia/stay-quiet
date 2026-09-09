// Requirement IDs: DEMODRIVE-01, DEMODRIVE-03, DEMODRIVE-04, DEMODRIVE-05,
// DEMODRIVE-RES-01, DEMODRIVE-RES-02, NONGOAL-14, XCUT-08 | Owned by M14 step 3
// (DP-D2b §3.3–§3.6, §4). Capture orchestration: Playwright Chromium headless
// (decided §3.3 / blueprint 6.16 — not revisited), one BrowserContext with
// native recordVideo, per-step loop over the validated script, mandatory video +
// boundary screenshots, offline egress guard, and RES-01 failure semantics.
// Capture only: no trimming/transcoding/assembly of artifacts ever (NONGOAL-14).

import {
  applyConfigDefaults,
  loadDemodriveScript,
  type DemodriveScript,
} from "./script.js";
import {
  createRunLayout,
  finalizeRunVideo,
  linkStepVideo,
  writeErrorSentinel,
  type RunLayout,
} from "./output.js";
import { executeStep, finishStepBoundary, type DemodrivePage } from "./capture.js";
import { startFeeder, type RunningFeeder } from "./feeder.js";
import { DemodrivePreflightFailed, DemodriveStepFailed } from "./errors.js";

export interface CaptureOptions {
  scriptPath: string;
  /** CLI override for script.data_source.kind (§8.1 flag table). */
  dataSource?: "mock" | "cache";
  /** Cache key override when kind=cache (--cache-key / data_source.cache_key). */
  cacheKey?: string;
  outRoot?: string;
  layout?: "single-focus" | "dashboard";
  configPath?: string;
  fast?: boolean;
  fullPage?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  runRoot?: string;
  error?: { name: string; message: string };
}

/** Structural surface of the Playwright bits we use, injectable for tests. */
export interface DriverIo {
  launch(): Promise<{
    newContext(opts: Record<string, unknown>): Promise<DriverContext>;
    close(): Promise<void>;
  }>;
}
export interface DriverContext {
  route(pattern: string, handler: (route: DriverRoute) => Promise<void>): Promise<void>;
  addInitScript(script: string): Promise<void> | void;
  newPage(): Promise<DemodrivePage & { videoPath(): Promise<string | null> }>;
  close(): Promise<void>;
}
export interface DriverRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** UI-04 theme ids the platform UI supports (src/platform/ui/theme.ts). */
const VALID_THEMES = new Set(["minimal", "editorial", "operator"]);

/** DEMODRIVE-04/REU-02 theme override resolution: a valid THEME env var wins,
 * then the script's optional `theme` field; anything else (unset, empty, or
 * unknown id) keeps the running UI's current theme — never an invented one. */
export function resolveThemeOverride(
  scriptTheme: string | null | undefined,
): string | null {
  const requested = process.env["THEME"] ?? scriptTheme ?? null;
  if (requested === null || requested === "") return null;
  return VALID_THEMES.has(requested) ? requested : null;
}

/** Init script forcing `data-theme` on <html>. The dev-shell bootstrap applies
 * env.theme during module evaluation, so we re-apply through load + a short
 * settle window to deterministically win without touching app code. */
export function themeInitScript(theme: string): string {
  return `(function(){
  var t = ${JSON.stringify(theme)};
  var el = document.documentElement;
  var apply = function(){ el.setAttribute("data-theme", t); };
  apply();
  document.addEventListener("DOMContentLoaded", apply);
  window.addEventListener("load", apply);
  var deadline = Date.now() + 2000;
  var iv = setInterval(function(){
    apply();
    if (Date.now() > deadline) clearInterval(iv);
  }, 50);
})();`;
}

function isLocalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? LOCAL_HOSTS.has(url.hostname)
      : false;
  } catch {
    return false; // data:/blob:/ws oddities are not localhost HTTP
  }
}

/** DEMODRIVE-RES-02 egress guard: every request must target the UI instance's
 * own localhost origin (or the feeder); everything else is aborted before it
 * leaves the machine. Zero non-local requests during capture, period. */
async function installEgressGuard(
  context: DriverContext,
  allowedUrls: string[],
): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (isLocalUrl(requestUrl)) {
      await route.continue();
      return;
    }
    console.warn(`[demodrive] blocked non-local request during capture: ${requestUrl}`);
    await route.abort();
  });
  void allowedUrls;
}

function resolveDataSource(script: DemodriveScript, opts: CaptureOptions) {
  const kind = opts.dataSource ?? script.data_source?.kind ?? "mock";
  const cacheKey = opts.cacheKey ?? script.data_source?.cache_key ?? undefined;
  return {
    kind,
    mock_script: script.data_source?.mock_script ?? undefined,
    cache_key: kind === "cache" ? cacheKey : undefined,
  };
}

async function stopFeederSafely(feeder: RunningFeeder | null): Promise<void> {
  if (!feeder) return;
  try {
    await feeder.stop();
  } catch {
    /* best-effort teardown */
  }
}

//#region SIGINT (§4 row 5)

let sigintInstalled = false;
export function installSigintHandler(onInterrupt: () => Promise<void>): void {
  if (sigintInstalled) return;
  sigintInstalled = true;
  process.once("SIGINT", () => {
    void onInterrupt().finally(() => process.exit(130));
  });
}

//#endregion

//#region Capture orchestration

/** Best-effort selector extraction from an executor error message (sentinel). */
function extractSelector(message: string): string | null {
  const m = /selector ([^\s)]+)/.exec(message);
  return m?.[1] ?? null;
}

/** Injectable driver core — tests stub io + feeder; production wires Playwright.
 * Failure semantics per DEMODRIVE-RES-01: context.close() FIRST (atomic video
 * finalization), prior assets preserved, named sentinel, structured result. */
export async function runCaptureCore(args: {
  script: DemodriveScript;
  opts: CaptureOptions;
  config: ReturnType<typeof applyConfigDefaults>["config"];
  io: DriverIo;
  startFeeder: typeof startFeeder;
  onProgress?: (msg: string) => void;
}): Promise<CaptureResult> {
  const { script, opts, config, io } = args;
  const log = args.onProgress ?? ((m: string) => console.log(`[demodrive] ${m}`));

  // DEMODRIVE-04: UI-06 single-focus is the default; dashboard is opt-in and
  // logged explicitly so the override is never silent.
  const layout = opts.layout ?? script.layout ?? config.layout;
  if (layout === "dashboard") log("mode: dashboard — non-default per UI-06");

  const outRoot = opts.outRoot ?? config.output.root;
  const layoutPlan: RunLayout = createRunLayout(script, outRoot);

  let context: DriverContext | null = null;
  let browser: Awaited<ReturnType<DriverIo["launch"]>> | null = null;
  let feeder: RunningFeeder | null = null;
  let interrupted = false;

  installSigintHandler(async () => {
    interrupted = true;
    try {
      await context?.close(); // video finalizes inside close()
    } catch {
      /* already closed */
    }
    writeErrorSentinel(layoutPlan.runRoot, {
      failed_step: "",
      step_index: -1,
      action_index: -1,
      selector: null,
      reason: "interrupted by SIGINT — completed prefix preserved",
      interrupted: true,
    });
  });

  try {
    // ---- Data-source feeder (DEMODRIVE-01) ---------------------------------
    const source = resolveDataSource(script, opts);
    if (source.kind === "mock" && !source.mock_script) {
      throw new Error("data_source.kind=mock requires data_source.mock_script path");
    }
    feeder = await args.startFeeder({ source, fast: opts.fast });
    void feeder.done.catch(() => undefined); // feeder logs its own failures

    // ---- BrowserContext (DEMODRIVE-03 native video) ------------------------
    browser = await io.launch();
    context = await browser.newContext({
      recordVideo: {
        dir: layoutPlan.runRoot,
        size:
          script.video?.size?.width && script.video?.size?.height
            ? { width: script.video.size.width, height: script.video.size.height }
            : { width: config.video.size.width ?? 1280, height: config.video.size.height ?? 720 },
      },
      viewport: {
        width: script.viewport?.width ?? config.viewport.width ?? 1280,
        height: script.viewport?.height ?? config.viewport.height ?? 720,
      },
      deviceScaleFactor:
        script.viewport?.device_scale_factor ?? config.viewport.deviceScaleFactor ?? 2,
    });

    // Offline guard first (DEMODRIVE-RES-02); then point API_BASE at the local
    // feeder so a UI configured for a live backend is redirected to mock/cache.
    await installEgressGuard(context, [script.base_url, feeder.url]);
    await context.addInitScript(`window.API_BASE = ${JSON.stringify(feeder.url)};`);
    // Optional theme override (script.theme / THEME env): minimal|editorial|
    // operator applied client-side; null keeps the UI's current theme.
    const themeOverride = resolveThemeOverride(script.theme);
    if (themeOverride) await context.addInitScript(themeInitScript(themeOverride));

    const page = await context.newPage();

    // ---- Preflight (§4 row 2): fails before any step assets are written ----
    try {
      await page.goto(script.base_url, { timeout: config.timeouts.preflight_ms });
    } catch (cause) {
      throw new DemodrivePreflightFailed(script.base_url, cause);
    }

    // ---- Per-step loop (DEMODRIVE-03/05 + RES-01 failure semantics) --------
    for (let s = 0; s < script.steps.length; s++) {
      const step = script.steps[s]!;
      const plan = layoutPlan.steps[s]!;
      log(`step ${s + 1}/${script.steps.length}: ${step.id}`);
      try {
        await executeStep({
          page,
          script,
          step,
          stepDir: plan.dir,
          actionsDir: plan.actionsDir,
          defaultTimeoutMs: config.timeouts.per_action_ms,
          fullPage: opts.fullPage === true,
        });
        await finishStepBoundary({
          page,
          step,
          defaultWaitAfterMs: config.timeouts.per_step_wait_after_ms,
          screenshotPath: plan.screenshotPath,
          fullPage: opts.fullPage === true,
        });
        linkStepVideo(plan.videoPath, layoutPlan.rootVideoPath);
      } catch (cause) {
        // RES-01: close the context FIRST so recordVideo finalizes atomically
        // (never partial/corrupt); already-written assets stay on disk.
        try {
          await context.close();
        } catch {
          /* close-once semantics */
        }
        context = null;
        const message = cause instanceof Error ? cause.message : String(cause);
        writeErrorSentinel(layoutPlan.runRoot, {
          failed_step: step.id,
          step_index: s,
          action_index: -1,
          selector: extractSelector(message),
          reason: message,
        });
        throw new DemodriveStepFailed(step.id, s, -1, extractSelector(message), message);
      }
      if (interrupted) break;
    }

    return { ok: true, runRoot: layoutPlan.runRoot };
  } catch (err) {
    return {
      ok: false,
      runRoot: layoutPlan.runRoot, // preserved assets live here (RES-01)
      error: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    try {
      await context?.close(); // idempotent; finalizes video on the success path
    } catch {
      /* already closed */
    }
    try {
      await browser?.close();
    } catch {
      /* best-effort */
    }
    // §3.6: rename the context recording to <runRoot>/video.webm and create the
    // per-step convenience links — on success AND failure (RES-01 preserves).
    finalizeRunVideo(layoutPlan);
    await stopFeederSafely(feeder);
  }
}

/** Production entry — loads Playwright lazily so validate-only runs and unit
 * suites never require a browser install (GOV-MIN-04 lazy chromium). */
export async function runCapture(opts: CaptureOptions): Promise<CaptureResult> {
  const loaded = loadDemodriveScript(opts.scriptPath);
  if (!loaded.ok) {
    return {
      ok: false,
      error: {
        name: "ValidationError",
        message: loaded.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      },
    };
  }
  // §8.1 .env row: DEMODRIVE_BASE_URL overrides the script's base_url (e.g. UI
  // running on an alternate port/host for a hermetic capture run).
  const baseUrlOverride = process.env["DEMODRIVE_BASE_URL"];
  if (baseUrlOverride) loaded.script.base_url = baseUrlOverride;
  const { config, warned } = applyConfigDefaults(opts.configPath);
  if (warned) console.warn(warned);

  const pw = (await import("@playwright/test")) as unknown as {
    chromium: { launch(opts?: Record<string, unknown>): Promise<unknown> };
  };
  return runCaptureCore({
    script: loaded.script,
    opts,
    config,
    startFeeder,
    io: {
      launch: async () => {
        return (await pw.chromium.launch({ headless: true })) as Awaited<
          ReturnType<DriverIo["launch"]>
        >;
      },
    },
  });
}

//#endregion
