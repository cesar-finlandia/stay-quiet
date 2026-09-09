// Requirement IDs: DATA-AC-01, DATA-01, DATA-02, DATA-03, DATA-04
// Acceptance — DP-H §9.1 verbatim arrange/act/assert structure. Isolation
// principle (blueprint §9): mocked ProviderCall only; no network, no real LLM,
// no chassis component beyond src/resilience stubs. Domain nouns appear here
// exactly because the test mirrors the checked-in examples/ fixtures.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRecords } from "../generate.js";
import { setProviderCall } from "../provider.js";
import { validate } from "src/resilience";
import type { JSONSchema } from "../types.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const supportTicketSchema = JSON.parse(
  readFileSync(join(REPO_ROOT, "examples", "dummy-fixtures", "data", "schemas", "support-ticket.schema.json"), "utf8"),
) as JSONSchema;
const syntheticBatchSchema = JSON.parse(
  readFileSync(join(REPO_ROOT, "contracts", "synthetic-batch.schema.json"), "utf8"),
) as object;

const DOMAIN =
  "Acme Corp synthetic support tickets for widget onboarding — Acme Corp is a fictional example company";
const MOCK_BATCH = [
  { ticket_id: "TKT-20001", category: "billing", priority: "low", summary: "Acme Corp widget invoice adjustment", status: "open" },
  { ticket_id: "TKT-20002", category: "access", priority: "high", summary: "Acme Corp SSO loop on widget console", status: "pending" },
  { ticket_id: "TKT-20003", category: "performance", priority: "medium", summary: "Widget preview latency on Acme Corp catalog pagination", status: "resolved" },
];

describe("DATA-AC-01 — schema-valid batch with synthetic marker", () => {
  it("dummy schema+domain → schema-valid synthetic batch with synthetic:true on every record", async () => {
    setProviderCall(async () => JSON.stringify(MOCK_BATCH)); // Arrange

    const result = await generateRecords(
      // Act
      { domain: DOMAIN, shape: { kind: "records", schema: supportTicketSchema, count: 3 }, watermark: true },
      { writeFile: false }, // temp-dir discipline — no fixture side effects
    );
    expect((result as { degraded?: unknown }).degraded).toBeUndefined(); // not DegradedResult
    const batch = (result as { batch: Array<Record<string, unknown>> }).batch;

    // Assert: schema validity via RES-04 (DATA-04 reuse) over records minus marker
    const batchSchema = { type: "array", items: supportTicketSchema, minItems: 3, maxItems: 3 };
    const stripped = batch.map(({ synthetic: _synthetic, ...rest }) => rest);
    const { valid, errors } = validate(batchSchema, stripped);
    expect(valid).toBe(true);
    if (!valid) console.error(errors);

    // Assert: synthetic marker present on every output (DATA-03)
    expect(batch.every((r) => r.synthetic === true)).toBe(true);
    expect(batch.length).toBe(3);

    // Assert: marker via contracts/synthetic-batch.schema.json on the FULL batch
    expect(validate(syntheticBatchSchema, batch).valid).toBe(true);
  });

  it("count-50 stress — full length, no crash, all marked", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      ticket_id: `TKT-${String(20100 + i).padStart(5, "0")}`,
      category: "billing",
      priority: "low",
      summary: `Acme Corp widget invoice adjustment number ${i}`,
      status: "open",
    }));
    setProviderCall(async () => JSON.stringify(fifty));
    const result = await generateRecords(
      { domain: DOMAIN, shape: { kind: "records", schema: supportTicketSchema, count: 50 }, watermark: true },
      { writeFile: false },
    );
    expect((result as { degraded?: unknown }).degraded).toBeUndefined();
    const batch = (result as { batch: unknown[] }).batch;
    expect(batch.length).toBe(50);
    expect(batch.every((r) => (r as { synthetic?: unknown }).synthetic === true)).toBe(true);
  });

  it("serialization — batch is plain JSON round-trippable (no circular refs)", async () => {
    setProviderCall(async () => JSON.stringify(MOCK_BATCH));
    const result = await generateRecords(
      { domain: DOMAIN, shape: { kind: "records", schema: supportTicketSchema, count: 3 }, watermark: true },
      { writeFile: false },
    );
    const batch = (result as { batch: unknown[] }).batch;
    const roundTrip = JSON.parse(JSON.stringify(batch)) as unknown;
    expect(roundTrip).toEqual(batch);
  });

  it("malformed record triggers one repair then succeeds (exactly 2 provider calls)", async () => {
    let calls = 0;
    setProviderCall(async () => {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify([{ ticket_id: "BAD", category: "billing", priority: "low", summary: "x", status: "open" }]);
      }
      return JSON.stringify([
        { ticket_id: "TKT-20010", category: "billing", priority: "low", summary: "Acme Corp billing correction", status: "open" },
      ]);
    });
    const r = await generateRecords(
      { domain: `${DOMAIN} (repair variant)`, shape: { kind: "records", schema: supportTicketSchema, count: 1 }, watermark: true },
      { writeFile: false },
    );
    expect(calls).toBe(2); // initial + EXACTLY ONE repair round-trip (DP-A §6.2)
    expect((r as { degraded?: unknown }).degraded).toBeUndefined();
    expect((r as { batch: Array<{ synthetic?: unknown }> }).batch[0]?.synthetic).toBe(true);
  });

  it("double-malformed falls back to DegradedResult, not crash", async () => {
    setProviderCall(async () => "not json at all");
    const r = await generateRecords(
      { domain: `${DOMAIN} (double-malformed variant)`, shape: { kind: "records", schema: supportTicketSchema, count: 2 }, watermark: true },
      { writeFile: false },
    );
    expect((r as { degraded?: unknown }).degraded).toBe(true);
    expect((r as { reason?: string }).reason).toMatch(/validation_repair_failed|primary_timeout|resilience_internal_error/);
  });
});
