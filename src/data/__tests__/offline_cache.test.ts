// Requirement IDs: RES-RES-02, DATA-05, DATA-RES-01
// Guard — DP-H §9.3 row 6 / §7.2 "cache fallback step hit": with a pre-populated
// GoldenCache and a rejecting provider, generateRecords serves the CACHED batch
// (re-validated, no repair leg) unchanged — offline airplane-mode pattern.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateRecords } from "../generate.js";
import { setProviderCall } from "../provider.js";
import { resolveConfig } from "../config.js";
import { createGoldenCache } from "src/resilience";

const ARGS = {
  domain: "offline cache-served fixture domain",
  shape: { kind: "records" as const, schema: { type: "object" }, count: 2 },
};
const KNOWN_BATCH = [{ ticket: "A-1" }, { ticket: "B-2" }];

/** Same derivation as the writer (§4.4) — write-through entries must be readable. */
function expectedKey(cacheDir: string): string {
  const resolved = resolveConfig({ cache: { dir: cacheDir } });
  return createGoldenCache(cacheDir).deriveKey({
    provider: resolved.provider ?? "unknown",
    model: resolved.model ?? "unknown",
    prompt: { domain: ARGS.domain, shape: ARGS.shape },
  });
}

describe("offline_cache (RES-RES-02 shared-suite pattern)", () => {
  it("pre-populated GoldenCache serves the batch with ZERO live provider traffic", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "data-offline-cache-"));
    const cache = createGoldenCache(cacheDir);
    await cache.put(expectedKey(cacheDir), KNOWN_BATCH); // pre-populate via write-through shape

    let attempted = 0;
    setProviderCall(async () => {
      attempted += 1;
      throw new Error("network disabled — provider unreachable");
    });

    const r = await generateRecords(
      {
        ...ARGS,
        cache: { enabled: true },
        config: {
          cache: { enabled: true, dir: cacheDir },
          resilience: {
            timeout_ms: 500,
            retries: 0,
            backoff: { policy: "exponential", base_ms: 10, factor: 1, max_ms: 10, jitter: false },
          },
        },
      },
      { writeFile: false }, // cache is the sink under test here
    );

    expect((r as { degraded?: unknown }).degraded).toBeUndefined(); // functionally complete
    const batch = (r as { batch?: Array<Record<string, unknown>> }).batch;
    expect(batch?.length).toBe(2);
    // cached content served UNCHANGED (plus code-injected marker, DATA-03)
    expect(batch?.map(({ synthetic: _s, ...rest }) => rest)).toEqual(KNOWN_BATCH);
    expect(batch?.every((x) => x.synthetic === true)).toBe(true);
    // primary was attempted exactly once (retries:0) — the SERVE came from cache
    expect(attempted).toBe(1);
  });
});
