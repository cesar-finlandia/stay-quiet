// OPTIONAL regeneration path for the synthetic fixtures. The committed files in
// fixtures/synthetic/ are the source of truth; this script exists so an operator can
// produce a fresh variant. It needs OPENAI_API_KEY and is NEVER part of the build:
// no test, no work unit and no runtime path depends on it.
//
//   node --experimental-strip-types scripts/generate_fixtures.mjs            # dry run, prints only
//   node --experimental-strip-types scripts/generate_fixtures.mjs --write    # overwrite fixtures
//
// If the generator degrades (no key, provider down) it prints the DegradedResult and
// exits 0 WITHOUT touching any file — a broken regeneration must never damage the
// committed fixtures.
import { writeFileSync } from "node:fs";
import { generateRecords } from "src/data/index.js";

const WRITE = process.argv.includes("--write");

const bookingSchema = {
  type: "object",
  required: ["booking_id", "listing_name", "guest_name", "check_in", "check_out",
             "nights", "payout_eur", "status", "policy_refs", "prior_disputes"],
  properties: {
    booking_id: { type: "string", pattern: "^BK-[0-9]{4}$" },
    listing_id: { type: "string" },
    listing_name: { type: "string" },
    guest_name: { type: "string" },
    check_in: { type: "string" },
    check_out: { type: "string" },
    nights: { type: "integer", minimum: 1, maximum: 14 },
    payout_eur: { type: "number", minimum: 50, maximum: 3000 },
    status: { type: "string", enum: ["confirmed", "cancellation_requested"] },
    policy_refs: { type: "array", items: { type: "string" } },
    prior_disputes: { type: "integer", minimum: 0, maximum: 5 },
    open_issue: { type: ["string", "null"], enum: ["guest_question", "cleaner_dispute", null] },
    cleaner_notes: { type: ["string", "null"] },
    guest_messages: { type: "array", items: { type: "object" } },
  },
};

const result = await generateRecords({
  domain:
    "bookings for an independent short-stay rental host with three listings, including guest message threads about cancellations, instalment requests and checkout cleaning tasks. No real people, addresses or booking references.",
  shape: { kind: "records", schema: bookingSchema, count: 6 },
  watermark: true,
});

if (result.degraded === true) {
  console.error("[fixtures] generator degraded — committed fixtures left untouched:", result.reason);
  process.exit(0);
}

console.log(JSON.stringify(result.batch, null, 2));
if (WRITE) {
  writeFileSync("fixtures/synthetic/bookings.json", JSON.stringify(result.batch, null, 2) + "\n");
  console.log(`[fixtures] wrote ${result.count} records to fixtures/synthetic/bookings.json`);
}
