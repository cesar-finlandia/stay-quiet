// Requirement IDs: DEMODRIVE-01, DEMODRIVE-RES-02, MOCK-01, MOCK-05, RES-05, TRN-04, XCUT-08
// Owned by M14 step 3 (DP-D2b §3.1). Data-source feeder: exactly two sources —
//   kind=mock  → replay a MOCK-01 script through the single TRN-04 publisher
//                (runMock from src/dev/mock), served to the UI over a local
//                HTTP SSE endpoint (handleEventStream, DP-B §4.2.1);
//   kind=cache → read envelopes from the RES-05 golden cache (createGoldenCache)
//                and republish them through the same local feeder.
// A live/unpredictable backend is never contacted during capture: the feeder
// binds 127.0.0.1 on an ephemeral port and the driver blocks all other egress.
//
// Reuse note (GOV-REU): this module owns no event logic of its own — MOCK owns
// scripts, RES-05 owns the store, TRN-04 owns publishing. It only wires them.

import http from "node:http";
import type { Server } from "node:http";
import { handleEventStream } from "../../platform/transport/stream_router.js";
import {
  createPublisher,
  type CollectablePublisher,
} from "../../platform/transport/publisher.js";
import type { EventEnvelope } from "../../platform/transport/event-envelope.js";
import { runMock } from "../../dev/mock/runner.js";
import { createGoldenCache } from "../../resilience/cache/index.js";
import type { DemodriveDataSource } from "./script.js";

export interface FeederOptions {
  source: DemodriveDataSource;
  /** --fast: emit back-to-back (MOCK realtime:false). */
  fast?: boolean;
  /** Test seam — inject an existing publisher instead of creating one. */
  publisher?: CollectablePublisher;
  /** Test seam — inject an existing cache instead of opening .cache/golden. */
  cache?: { get(key: string): Promise<unknown | null>; deriveKey(input: { explicitKey: string }): string };
}

export interface RunningFeeder {
  /** Local SSE/fallback base URL the UI should subscribe to (API_BASE). */
  url: string;
  /** Resolves when the underlying mock replay/cache read finishes. */
  done: Promise<void>;
  stop(): Promise<void>;
}

function looksLikeEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.step_id === "string" && typeof v.status === "string";
}

/** Start the local data-source feeder (DEMODRIVE-01). Binds 127.0.0.1:0 —
 * localhost-only by construction, satisfying the offline guarantee surface
 * (DEMODRIVE-RES-02); the driver additionally blocks all other egress. */
export async function startFeeder(opts: FeederOptions): Promise<RunningFeeder> {
  const publisher = opts.publisher ?? (createPublisher() as CollectablePublisher);
  const server: Server = http.createServer(handleEventStream(publisher));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;

  let done: Promise<void>;
  if (opts.source.kind === "mock") {
    // MOCK-01 replay via the one TRN-04 primitive — indistinguishable from a
    // real backend on the wire (DP-D2b §3.1; runMock validates + paces).
    done = runMock({
      scriptPath: opts.source.mock_script ?? undefined,
      realtime: !opts.fast,
      publisher,
    })
      .then(() => undefined)
      .catch((err: unknown) => {
        throw new Error(
          `mock feeder failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  } else {
    // RES-05 cache read — file-local JSON only (never a network fetch).
    done = (async () => {
      const explicit = opts.source.cache_key;
      if (!explicit) {
        console.warn(
          "warn: demodrive cache feeder started without data_source.cache_key — nothing to republish",
        );
        return;
      }
      const cache =
        opts.cache ??
        (createGoldenCache() as unknown as {
          get(key: string): Promise<unknown | null>;
          deriveKey(input: { explicitKey: string }): string;
        });
      const key = cache.deriveKey({ explicitKey: explicit });
      let value: unknown | null;
      try {
        value = await cache.get(key);
      } catch (err) {
        console.warn(`cache_miss: key ${explicit} — cache get failed (${String(err)})`);
        return;
      }
      if (value === null || !looksLikeEnvelope(value)) {
        // RES-RES-02 analogue (§4 row 4): warn + continue so the UI renders its
        // DegradedResult banner; capture still produces video+screenshots.
        console.warn(`cache_miss: key ${explicit} — no golden entry`);
        return;
      }
      await publisher.publish({
        stepId: value.step_id,
        status: value.status,
        payload: value.payload ?? {},
        traceId: value.trace_id,
        degraded: value.degraded,
      });
    })();
  }

  return {
    url,
    done,
    stop: async () => {
      try {
        await publisher.close();
      } catch {
        /* already closed */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
