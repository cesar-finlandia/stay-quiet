// Requirement IDs: DATA-03, GOV-RES-04
// Guard — DP-H §9.3 row 1: success paths of both generate functions carry the
// synthetic marker on EVERY element; a batch mutated to drop the marker fails
// contracts/synthetic-batch.schema.json (marker is machine-checkable).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRecords, generateDocuments } from "../generate.js";
import { setProviderCall } from "../provider.js";
import { validate } from "src/resilience";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const syntheticBatchSchema = JSON.parse(
  readFileSync(join(REPO_ROOT, "contracts", "synthetic-batch.schema.json"), "utf8"),
) as object;

const RECORDS_ARGS = {
  domain: "guard fixture domain for marker checks",
  shape: { kind: "records" as const, schema: { type: "object" }, count: 2 },
};
const DOCS_ARGS = {
  domain: "guard fixture domain for marker checks",
  shape: { kind: "documents" as const, doc_type: "general" as const, count: 2 },
};

describe("marker_presence (DATA-03)", () => {
  it("generateRecords marks every record on success", async () => {
    setProviderCall(async () => JSON.stringify([{ a: 1 }, { b: 2 }]));
    const r = await generateRecords(RECORDS_ARGS, { writeFile: false });
    const batch = (r as { batch?: Array<{ synthetic?: unknown }> }).batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch?.every((x) => x.synthetic === true)).toBe(true);
  });

  it("generateDocuments marks every document on success", async () => {
    setProviderCall(async () => JSON.stringify([{ content: "one paragraph\n\nanother" }, { content: "solo" }]));
    const r = await generateDocuments(DOCS_ARGS, { writeFile: false });
    const batch = (r as { batch?: Array<{ synthetic?: unknown }> }).batch;
    expect(batch?.every((x) => x.synthetic === true)).toBe(true);
  });

  it("mutated batch without the marker FAILS contracts/synthetic-batch.schema.json", async () => {
    setProviderCall(async () => JSON.stringify([{ a: 1 }, { a: 2 }]));
    const r = await generateRecords(RECORDS_ARGS, { writeFile: false });
    const batch = (r as { batch: Array<Record<string, unknown>> }).batch;
    const stripped = batch.map(({ synthetic: _s, ...rest }) => rest); // simulate a stripper
    expect(validate(syntheticBatchSchema, stripped).valid).toBe(false);
    expect(validate(syntheticBatchSchema, batch).valid).toBe(true); // intact batch passes
  });
});
