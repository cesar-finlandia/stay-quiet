// Requirement IDs: DEMODRIVE-RES-01, GOV-RES-01, XCUT-08 | Owned by M14 step 3 (DP-D2b §4)
// Typed DEMODRIVE failures. Every path exits with a named error — never an
// unhandled crash, never a silent hang (GOV-RES-01/04).

/** Preflight gate: the running UI instance was unreachable (§4 table row 2). */
export class DemodrivePreflightFailed extends Error {
  readonly reason = "preflight_failed";
  constructor(readonly baseUrl: string, cause?: unknown) {
    super(
      `DemodrivePreflightFailed: base_url ${baseUrl} unreachable — is the UI running? Run: npm run dev`,
    );
    this.name = "DemodrivePreflightFailed";
  }
}

/** Mid-sequence step failure; names the failing step/action/selector (§4 row 1).
 * Already-captured assets stay on disk; video finalizes on context.close(). */
export class DemodriveStepFailed extends Error {
  readonly reason = "step_failed";
  constructor(
    readonly stepId: string,
    readonly stepIndex: number,
    readonly actionIndex: number,
    readonly selector: string | null,
    causeMessage: string,
  ) {
    super(
      `DemodriveStepFailed: step ${stepId} (action ${actionIndex} selector ${selector ?? "none"}) — ${causeMessage}`,
    );
    this.name = "DemodriveStepFailed";
  }
}
