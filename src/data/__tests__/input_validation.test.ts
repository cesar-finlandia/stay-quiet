// Requirement IDs: GOV-RES-02, DATA-01
// Guard — DP-H §9.3 row 2: contract-invalid inputs return
// DegradedResult{reason:"invalid_input"} with ZERO provider invocations.
import { describe, expect, it } from "vitest";
import { generateRecords } from "../generate.js";
import { setProviderCall } from "../provider.js";
import type { GenerateArgs } from "../types.js";

const BASE = {
  domain: "valid length domain description",
  shape: { kind: "records", schema: { type: "object" }, count: 2 },
} as unknown as GenerateArgs;

async function calls(): Promise<{ n: () => number }> {
  let n = 0;
  setProviderCall(async () => {
    n += 1;
    return "[]";
  });
  return { n: () => n };
}

describe("input_validation (GOV-RES-02) — invalid input → degraded, zero LLM calls", () => {
  it("empty/too-short domain", async () => {
    const c = await calls();
    const r = await generateRecords({ ...BASE, domain: "" }, { writeFile: false });
    expect((r as { degraded?: boolean }).degraded).toBe(true);
    expect((r as { reason?: string }).reason).toBe("invalid_input");
    expect(c.n()).toBe(0);
  });

  it("missing shape", async () => {
    const c = await calls();
    const r = await generateRecords({ domain: "valid length domain description" } as unknown as GenerateArgs, {
      writeFile: false,
    });
    expect((r as { degraded?: boolean }).degraded).toBe(true);
    expect((r as { reason?: string }).reason).toBe("invalid_input");
    expect(c.n()).toBe(0);
  });

  it("count > 200 hard ceiling", async () => {
    const c = await calls();
    const r = await generateRecords(
      {
        ...BASE,
        shape: { kind: "records", schema: { type: "object" }, count: 201 },
      } as GenerateArgs,
      { writeFile: false },
    );
    expect((r as { degraded?: boolean }).degraded).toBe(true);
    expect((r as { reason?: string }).reason).toBe("invalid_input");
    expect(c.n()).toBe(0);
  });

  it("unknown shape.kind", async () => {
    const c = await calls();
    const r = await generateRecords(
      { ...BASE, shape: { kind: "bogus", count: 2 } } as unknown as GenerateArgs,
      { writeFile: false },
    );
    expect((r as { degraded?: boolean }).degraded).toBe(true);
    expect((r as { reason?: string }).reason).toBe("invalid_input");
    expect(c.n()).toBe(0);
  });
});
