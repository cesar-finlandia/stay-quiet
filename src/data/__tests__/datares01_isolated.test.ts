// Requirement IDs: DATA-RES-01, GOV-RES-01
// Guard — DP-H §9.3 row 5: a rejecting provider yields a typed DegradedResult
// within budget. generateRecords NEVER throws; the caller gets a detectable
// degraded signal consumable by UI-RES-02 / MOCK-01.
import { describe, expect, it } from "vitest";
import { generateRecords, generateDocuments } from "../generate.js";
import { setProviderCall } from "../provider.js";

describe("datares01_isolated (DATA-RES-01 / GOV-RES-01)", () => {
  it("provider rejection → DegradedResult within budget, never throws (records)", async () => {
    setProviderCall(() => Promise.reject(new Error("provider down")));
    const started = Date.now();
    const r = await generateRecords(
      {
        domain: "isolated degraded-path fixture domain",
        shape: { kind: "records", schema: { type: "object" }, count: 2 },
        // shrink RES-01 budget so the test stays fast; retries:0 → single attempt
        config: {
          resilience: {
            timeout_ms: 500,
            retries: 0,
            backoff: { policy: "exponential", base_ms: 10, factor: 1, max_ms: 10, jitter: false },
          },
        },
      },
      { writeFile: false },
    );
    expect(Date.now() - started).toBeLessThan(15000); // budget bound — no hangs
    expect((r as { degraded?: boolean }).degraded).toBe(true);
    expect((r as { reason?: string }).reason).toMatch(/primary_failed|primary_timeout|provider_unavailable|resilience_internal_error/);
    expect((r as { fallback_source?: string }).fallback_source).toBe("none");
  });

  it("provider rejection → DegradedResult, never throws (documents)", async () => {
    setProviderCall(async () => {
      throw new Error("provider down");
    });
    const r = await generateDocuments(
      {
        domain: "isolated degraded-path fixture domain",
        shape: { kind: "documents", doc_type: "general", count: 1 },
        config: {
          resilience: {
            timeout_ms: 500,
            retries: 0,
            backoff: { policy: "exponential", base_ms: 10, factor: 1, max_ms: 10, jitter: false },
          },
        },
      },
      { writeFile: false },
    );
    expect((r as { degraded?: boolean }).degraded).toBe(true);
    expect((r as { batch?: unknown }).batch).toBeUndefined();
  });
});
