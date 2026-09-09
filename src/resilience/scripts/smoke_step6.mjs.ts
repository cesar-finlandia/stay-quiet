// Runtime smoke mirroring DP-A §10.4 + sync-variant containment (not an acceptance test).
import { withValidation, withResilienceSync, isDegradedResult } from "../../resilience/index.js";
import type { DegradedResult } from "../../resilience/index.js";

const schema = {
  type: "object",
  required: ["title", "score"],
  properties: { title: { type: "string" }, score: { type: "number" } },
};

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`${name} OK`);
  else {
    failures++;
    console.error(`${name} FAIL`, JSON.stringify(detail) ?? "");
  }
}

async function main(): Promise<number> {
  // Case 1: async primary + async repairLlm -> repaired value, EXACTLY ONE call.
  let calls = 0;
  const repairGoodAsync = async (_prompt: string): Promise<string> => {
    calls++;
    return JSON.stringify({ title: "Acme widget", score: 42 });
  };
  const malformedAsync = async (): Promise<string> =>
    JSON.stringify({ title: "Acme widget", score: "not a number" });
  const w1 = withValidation(malformedAsync, schema, { timeout_ms: 1000, retries: 1, fallback_chain: { order: ["none"] } }, { repairLlm: repairGoodAsync });
  const r1 = await w1();
  check("case1", !isDegradedResult(r1) && JSON.stringify(r1) === JSON.stringify({ title: "Acme widget", score: 42 }) && calls === 1, r1);

  // Case 2: garbage repairLlm -> DegradedResult(validation_repair_failed), no throw.
  const repairGarbage = async (_prompt: string): Promise<string> => "still not json";
  const w2 = withValidation(async () => "bad", schema, { timeout_ms: 1000, retries: 3, fallback_chain: { order: ["none"] } }, { repairLlm: repairGarbage });
  const r2 = (await w2()) as DegradedResult;
  check("case2", isDegradedResult(r2) && r2.reason === "validation_repair_failed", r2);

  // Case 3: withResilienceSync + SYNC validateResult hook -> plain value out, no Promise leak.
  const w3 = withResilienceSync(
    () => JSON.stringify({ title: "Acme widget", score: 7 }),
    { timeout_ms: 1000, retries: 2, fallback_chain: { order: ["none"] } },
    { validateResult: (raw) => JSON.parse(String(raw)) },
  );
  const r3 = w3();
  const leaked3 = r3 instanceof Promise;
  check("case3", !leaked3 && !isDegradedResult(r3) && JSON.stringify(r3) === JSON.stringify({ title: "Acme widget", score: 7 }), r3);

  // Case 4: withResilienceSync + ASYNC validateResult hook cannot be joined ->
  // DegradedResult(validation_repair_failed), never a leaked Promise or throw.
  const w4 = withResilienceSync(
    () => "bad",
    { timeout_ms: 1000, retries: 5, fallback_chain: { order: ["none"] } },
    { validateResult: () => Promise.resolve("nope") },
  );
  const r4 = w4();
  const leaked4 = r4 instanceof Promise;
  check("case4", !leaked4 && isDegradedResult(r4) && r4.reason === "validation_repair_failed", r4);

  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
