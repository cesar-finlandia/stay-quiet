import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_PROFILE, resolveConfig, resolveModelProfile } from "../config.js";

describe("resolveConfig smoke (step 3)", () => {
  it("resolves defaults from shared file + defaults.json", () => {
    const c = resolveConfig();
    expect(c.role).toBe("data-generator");
    expect(c.modelProfile).toBe(DEFAULT_MODEL_PROFILE);
    expect(c.batch.maxCount).toBe(200);
    expect(c.watermark.enabled).toBe(true);
    expect(typeof c.provider).toBe("string");
  });

  it("never throws on malformed config; substitutes safe values", () => {
    const c = resolveConfig({
      batch: { maxCount: -5 },
      resilience: { timeout_ms: -1 },
      // @ts-expect-error deliberately malformed input (enabled must be boolean)
      watermark: { enabled: "yes" },
      bogusKey: 1,
    });
    expect(c.batch.maxCount).toBe(200);
    expect(c.modelProfile.length).toBeGreaterThan(0);
  });

  it("resolveModelProfile returns profile name", () => {
    expect(resolveModelProfile()).toBe("balanced");
    expect(resolveModelProfile({ model_profile: "fast" })).toBe("fast");
  });
});
