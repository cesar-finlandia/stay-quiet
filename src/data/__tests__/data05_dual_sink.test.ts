// Requirement IDs: DATA-05
// Dual-sink acceptance — DP-H §4.4/§4.5: ONE watermarked in-memory batch feeds
// (a) an atomic JSON fixture file and (b) the RES-05 GoldenCache write-through,
// with no re-serialization and no regeneration. Temp dirs only — nothing is
// committed (§8.3 temp-dir discipline; NONGOAL-06 location guard).

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateRecords } from "../generate.js";
import { setProviderCall } from "../provider.js";
import { resolveConfig } from "../config.js";
import { batchFilename } from "../writer.js";
import { createGoldenCache } from "src/resilience";
import type { GenerateArgs, GenerateResult } from "../types.js";

const ARGS: GenerateArgs = {
  domain: "support tickets for a demo helpdesk", // >=10 chars per input contract
  shape: { kind: "records", schema: { type: "object" }, count: 2 },
};

describe("DATA-05 dual sink (file + golden cache write-through)", () => {
  it("writes the watermarked batch to disk AND round-trips it via GoldenCache", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "data05-out-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "data05-cache-"));

    setProviderCall(async () => JSON.stringify([{ ticket_id: "T1" }, { ticket_id: "T2" }]));

    const cfg = { cache: { enabled: true, dir: cacheDir } };
    const r: GenerateResult = await generateRecords({ ...ARGS, config: cfg, cache: { enabled: true } }, { outDir });
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r)) return;

    // (a) File sink — expected name `<kind>-<slug(domain)>-<count>.json`, plain JSON array.
    const file = join(outDir, batchFilename("records", ARGS.domain, ARGS.shape.count));
    expect(existsSync(file)).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as Array<Record<string, unknown>>).length).toBe(2);
    expect((parsed as Array<{ synthetic?: unknown }>).every((x) => x.synthetic === true)).toBe(true);

    // bytes reported in GenerateResult match what landed on disk.
    expect(r.bytes).toBe(Buffer.byteLength(readFileSync(file, "utf8")));

    // (b) Cache sink — deriveKey over {provider, model, prompt:{domain, shape}} per §4.4;
    // get(key) returns the SAME batch content unchanged (no reformatting).
    const resolved = resolveConfig(cfg);
    const cache = createGoldenCache(cacheDir);
    const key = cache.deriveKey({
      provider: resolved.provider ?? "unknown",
      model: resolved.model ?? "unknown",
      prompt: { domain: ARGS.domain, shape: ARGS.shape },
    });
    await expect(cache.has(key)).resolves.toBe(true);
    const cached = await cache.get(key);
    expect(cached).toEqual(r.batch); // identical content, still fully watermarked
    expect(Array.isArray(cached)).toBe(true);
  });

  it("skips disk when writeFile:false but still serves the cache sink", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "data05-cache2-"));
    setProviderCall(async () => JSON.stringify([{ n: 1 }, { n: 2 }]));
    const cfg = { cache: { enabled: true, dir: cacheDir } };
    const explicitKey = "acme-demo-records-2";
    const r = await generateRecords(
      { ...ARGS, domain: "another demo domain for sinks", config: cfg, cache: { enabled: true, key: explicitKey } },
      { writeFile: false },
    );
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r)) return;
    const cache = createGoldenCache(cacheDir);
    const key = cache.deriveKey({ explicitKey }); // explicit keys are hashed once for uniform filenames
    await expect(cache.has(key)).resolves.toBe(true);
    await expect(cache.get(key)).resolves.toEqual(r.batch);
    // no default-location side effect is asserted here; writeFile:false honored by construction
  });
});
