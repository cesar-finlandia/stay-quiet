// Requirement IDs: RES-REU-02, DATA-REU-01
// Guard — DP-H §9.3 row 7 / §6.4: swapping setProviderCall between two
// differently-shaped dummy adapters mid-test yields an IDENTICAL output shape.
// The core never branches on provider identity — the seam is the only variable.
import { describe, expect, it } from "vitest";
import { generateRecords } from "../generate.js";
import { setProviderCall } from "../provider.js";
import type { ProviderCall } from "../provider.js";

const ARGS = {
  domain: "provider-agnostic fixture domain for swaps",
  shape: { kind: "records" as const, schema: { type: "object" }, count: 2 },
};
const PAYLOAD = JSON.stringify([{ n: 1 }, { n: 2 }]);

/** "Vendor A"-shaped adapter — non-async function returning an already-resolved promise. */
const adapterA: ProviderCall = (_prompt, _model_profile) => {
  // deliberately different closure style from adapterB; same wire payload
  return Promise.resolve(PAYLOAD);
};

/** "Vendor B"-shaped adapter — different closure style + microtask delay. */
const adapterB: ProviderCall = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return PAYLOAD;
};

describe("provider_agnostic (RES-REU-02 / §6.4)", () => {
  it("swapping adapters mid-test produces identical output shape", async () => {
    setProviderCall(adapterA);
    const ra = await generateRecords(ARGS, { writeFile: false });
    expect((ra as { degraded?: unknown }).degraded).toBeUndefined();
    const batchA = (ra as { batch: unknown[] }).batch;

    setProviderCall(adapterB); // swap WITHOUT touching core code or config shape
    const rb = await generateRecords(ARGS, { writeFile: false });
    expect((rb as { degraded?: unknown }).degraded).toBeUndefined();
    const batchB = (rb as { batch: unknown[] }).batch;

    // Same shape: length, marker presence, and content identical for equal payloads
    expect(batchB.length).toBe(batchA.length);
    expect(batchB).toEqual(batchA);
    expect(batchA.every((x) => (x as { synthetic?: unknown }).synthetic === true)).toBe(true);
    expect(batchB.every((x) => (x as { synthetic?: unknown }).synthetic === true)).toBe(true);
  });
});
