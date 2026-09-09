import { describe, expect, it } from "vitest";
import { generateRecords, generateDocuments } from "../generate.js";
import { setProviderCall } from "../provider.js";
import type { GenerateArgs, GenerateResult, SyntheticDocument } from "../types.js";

const RECORDS_ARGS: GenerateArgs = {
  domain: "acme corp demo records for rehearsal", // >=10 chars per input contract
  shape: { kind: "records", schema: { type: "object" }, count: 2 },
};

const DOCS_ARGS: GenerateArgs = {
  domain: "acme corp demo records for rehearsal",
  shape: { kind: "documents", doc_type: "faq", count: 2 },
};

describe("generateDocuments pipeline (step 4)", () => {
  it("watermarks docs: header inside content + watermark_header field", async () => {
    setProviderCall(async () =>
      JSON.stringify([{ content: "para one\n\npara two" }, { content: "solo paragraph" }]),
    );
    const r = await generateDocuments(DOCS_ARGS, { writeFile: false });
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r)) return;
    expect(r.batch.every((x) => x.synthetic === true)).toBe(true);
    const first = r.batch[0] as SyntheticDocument;
    expect(String(first.content)).toMatch(/^SYNTHETIC DEMO DATA — NOT REAL\n\n/);
    expect(first.watermark_header).toBe("SYNTHETIC DEMO DATA — NOT REAL");
  });

  it("degrades with document_structural_check_failed when content missing", async () => {
    setProviderCall(async () => JSON.stringify([{ nope: true }]));
    const r = await generateDocuments(DOCS_ARGS);
    if ("ok" in r) return expect.fail("expected degraded result");
    expect(r.degraded).toBe(true);
    expect(r.reason).toBe("document_structural_check_failed");
  });
});

describe("generateRecords pipeline (step 4)", () => {
  it("returns watermarked batch when provider emits schema-valid JSON", async () => {
    setProviderCall(async () => JSON.stringify([{ a: 1 }, { a: 2 }]));
    const r: GenerateResult = await generateRecords(RECORDS_ARGS, { writeFile: false });
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r)) return;
    expect(r.batch.length).toBe(2);
    expect(r.batch.every((x) => x.synthetic === true)).toBe(true);
  });

  it("degrades with validation_repair_failed when provider returns garbage twice", async () => {
    let calls = 0;
    setProviderCall(async () => {
      calls += 1;
      return "totally not json";
    });
    const r = await generateRecords(RECORDS_ARGS);
    if ("ok" in r) return expect.fail("expected degraded result");
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/validation_repair_failed/);
    expect(calls).toBe(2); // initial + EXACTLY ONE repair round-trip (DP-A §6.2)
  });

  it("returns invalid_input without any LLM call for a too-short domain", async () => {
    let calls = 0;
    setProviderCall(async () => {
      calls += 1;
      return "[]";
    });
    const r = await generateRecords({ ...RECORDS_ARGS, domain: "short" });
    if ("ok" in r) return expect.fail("expected degraded result");
    expect(r.degraded).toBe(true);
    expect(r.reason).toBe("invalid_input");
    expect(calls).toBe(0);
  });
});
