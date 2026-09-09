// Requirement IDs: DATA-05
// Output writer for the synthetic demo-data generator — DP-H §4.4/§4.5.
//
// One already-watermarked in-memory batch feeds TWO sinks with no
// re-serialization and no regeneration:
//   (a) atomic JSON file write (tmp + rename, DP-A §5.3) to the caller's
//       outDir ?? <cwd>/fixtures/synthetic/ (NONGOAL-06 location guard —
//       NEVER examples/), filename `<shape-kind>-<slug(domain)>-<count>.json`;
//   (b) optional RES-05 GoldenCache write-through when cache.enabled —
//       deriveKey({provider, model, prompt:{domain, shape}}) or an explicit
//       key; put() receives the SAME batch reference, source:"data".
//
// Guarantees (DP-H §7.2): every stage is individually try/catch-guarded;
// a write or cache failure logs a warn and never turns an ok batch into a
// crash — no throw escapes writeBatch. Output stays plain Array<object> JSON
// (master_blueprint §6.4) — never newline-delimited, never YAML.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGoldenCache } from "src/resilience";
import type { DataGeneratorConfig } from "./types.js";
import { resolveConfig } from "./config.js";

/** Shape discriminator + domain/count needed for the filename convention. */
export type WriterKind = "records" | "documents" | "freeform";

/** Caller-controlled sink knobs — NOT part of the frozen GenerateArgs contract. */
export interface SinkOptions {
  /** Destination directory for the JSON file. Default <cwd>/fixtures/synthetic/. */
  outDir?: string;
  /** Default true; false skips disk so MOCK-01 can be the sole writer (§4.5). */
  writeFile?: boolean;
}

/** Per-batch sink options. */
export interface WriteBatchArgs extends SinkOptions {
  kind: WriterKind;
  domain: string;
  count: number;
  /** DATA-05 write-through options (mirrors GenerateArgs.cache). */
  cache?: { enabled?: boolean; key?: string; provider?: string; model?: string };
  /** Full OutputShape — folded into deriveKey input per §4.4 when present. */
  shape?: unknown;
  /** Resolved for cache dir override + provider/model traceability. */
  config?: DataGeneratorConfig;
}

/** Bytes written to disk this call; 0 when writeFile:false or on guarded failure. */
export type WriteBatchResult = number;

/** Default destination per §4.5 / §8.2 — real output NEVER lands in examples/. */
function defaultOutDir(): string {
  return join(process.cwd(), "fixtures", "synthetic");
}

/** `<shape-kind>-<slug(domain)>-<count>.json`, e.g. records-support-tickets-50.json. */
export function batchFilename(kind: string, domain: string, count: number): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  return `${kind}-${slug || "batch"}-${count}.json`;
}

/** Atomic tmp+rename write (DP-A §5.3) — mirrors src/resilience/cache/store.ts. */
function atomicWrite(target: string, data: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, target);
}

/**
 * writeBatch — dual-sink fan-out of ONE watermarked batch (DATA-05).
 * Never throws; returns bytes written to disk (0 if skipped/failed).
 */
export async function writeBatch(batch: unknown[], args: WriteBatchArgs): Promise<WriteBatchResult> {
  let bytes = 0;

  // Sink (a) — atomic file write. Guarded: a disk failure must not crash a caller.
  if (args.writeFile !== false) {
    try {
      const dir = args.outDir && args.outDir.trim() ? args.outDir : defaultOutDir();
      mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(batch, null, 2) + "\n"; // plain Array<object> JSON only
      const target = join(dir, batchFilename(args.kind, args.domain, args.count));
      atomicWrite(target, payload);
      bytes = Buffer.byteLength(payload, "utf8");
    } catch (e) {
      console.warn(`[data] warn: fixture write failed (${e instanceof Error ? e.message : String(e)}); returning in-memory batch`);
    }
  }

  // Sink (b) — RES-05 golden-cache write-through of the SAME in-memory reference.
  if (args.cache?.enabled === true) {
    try {
      const cfg = resolveConfig(args.config);
      const rootDir = typeof cfg.cache.dir === "string" && cfg.cache.dir.trim() ? cfg.cache.dir.trim() : undefined;
      const cache = createGoldenCache(rootDir);
      const provider = args.cache.provider ?? args.config?.provider ?? cfg.provider ?? "unknown";
      const model = args.cache.model ?? cfg.model ?? "unknown";
      const key =
        args.cache.key && args.cache.key.trim()
          ? cache.deriveKey({ explicitKey: args.cache.key.trim() }) // hashed for uniform filenames (§5.2)
          : cache.deriveKey({ provider, model, prompt: { domain: args.domain, shape: args.shape ?? args.kind } });
      await cache.put(key, batch, {
        provider,
        model,
        source: "data",
        ...(args.cache.key ? { explicit_key: args.cache.key } : {}),
      });
    } catch (e) {
      console.warn(`[data] warn: golden-cache write-through failed (${e instanceof Error ? e.message : String(e)}); returning in-memory batch`);
    }
  }

  return bytes;
}
