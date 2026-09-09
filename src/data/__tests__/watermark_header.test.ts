// Requirement IDs: DATA-03
// Guard — DP-H §9.3 row 3: with watermark enabled every document content STARTS
// with the configured header; the header survives metadata stripping (permanence);
// watermark:false without allowDisableWatermark still yields markers + a warning.
import { describe, expect, it, vi, afterEach } from "vitest";
import { generateDocuments } from "../generate.js";
import { setProviderCall } from "../provider.js";
import { WATERMARK_HEADER_TEXT } from "../watermark.js";
import type { GenerateArgs } from "../types.js";

const ARGS: GenerateArgs = {
  domain: "guard fixture domain for header checks",
  shape: { kind: "documents", doc_type: "policy", count: 2 },
};

const MOCK_DOCS = [
  { content: "first paragraph\n\nsecond paragraph", title: "T1" },
  { content: "only one paragraph here" },
];

afterEach(() => vi.restoreAllMocks());

describe("watermark_header (DATA-03 permanence)", () => {
  it("every document content starts with the configured header", async () => {
    setProviderCall(async () => JSON.stringify(MOCK_DOCS));
    const r = await generateDocuments(ARGS, { writeFile: false });
    const docs = (r as { batch: Array<{ content: string }> }).batch;
    expect(docs.every((d) => d.content.startsWith(WATERMARK_HEADER_TEXT))).toBe(true);
  });

  it("header remains inside content even if metadata is stripped", async () => {
    setProviderCall(async () => JSON.stringify(MOCK_DOCS));
    const r = await generateDocuments(ARGS, { writeFile: false });
    const stripped = (r as { batch: Array<Record<string, unknown>> }).batch.map((d) => {
      const { metadata: _m, ...rest } = d; // simulate aggressive downstream stripping
      return rest;
    });
    expect(
      stripped.every((d) => String(d["content"]).startsWith(WATERMARK_HEADER_TEXT) && d["watermark_header"] === WATERMARK_HEADER_TEXT),
    ).toBe(true);
  });

  it("watermark:false without allowDisableWatermark STILL marks + warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setProviderCall(async () => JSON.stringify(MOCK_DOCS));
    const r = await generateDocuments({ ...ARGS, watermark: false }, { writeFile: false });
    const batch = (r as { batch: Array<Record<string, unknown>> }).batch;
    expect(batch.every((d) => d["synthetic"] === true)).toBe(true);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes("watermark"))).toBe(true);
  });

  it("custom headerText from config is honored", async () => {
    setProviderCall(async () => JSON.stringify(MOCK_DOCS));
    const custom = "DEMO ONLY — SYNTHETIC HEADER";
    const r = await generateDocuments(
      { ...ARGS, config: { watermark: { headerText: custom } } },
      { writeFile: false },
    );
    const docs = (r as { batch: Array<{ content: string }> }).batch;
    expect(docs.every((d) => d.content.startsWith(custom))).toBe(true);
  });
});
