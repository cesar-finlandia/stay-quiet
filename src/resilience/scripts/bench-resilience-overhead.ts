// Requirement IDs: RES-RES-01, XCUT-08
// Latency-overhead benchmark (DP-A §8.4 / §10.5).
//
//   npx tsx src/resilience/scripts/bench-resilience-overhead.ts
//
// Measures per-call overhead of the resilience wrapper on the success path
// (no retry, no fallback): wrapped `dummyFastCall` vs raw call, 1000 paired
// iterations; overhead_i = wrapped_i - raw_i. Reports median/p95/p99/mean for
// async (withResilience) and sync (withResilienceSync) paths and prints JSON.
//
// Domain-free (GOV-REU-02); node stdlib only (RES-REU-01); zero deps.

import { performance } from "node:perf_hooks";
import process from "node:process";
import { withResilience, withResilienceSync } from "../index.js";

const SAMPLES = 1000;

interface Stats {
  median_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
}

//#region stats helpers

/** Percentile of a sorted numeric sample (linear interpolation, nearest-rank-ish). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function summarize(overheadsMs: number[]): Stats {
  const sorted = [...overheadsMs].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    median_ms: round3(percentile(sorted, 50)),
    p95_ms: round3(percentile(sorted, 95)),
    p99_ms: round3(percentile(sorted, 99)),
    mean_ms: round3(n > 0 ? sum / n : 0),
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

//#endregion

//#region measurement loops

/**
 * Paired measurement loop per §8.4 pseudocode: each iteration times the
 * wrapped call and the raw call back-to-back; overhead = wrapped - raw.
 */
async function measureAsync(): Promise<number[]> {
  const dummyFastCall = async (): Promise<string> => "ok";
  const wrapped = withResilience(dummyFastCall, null);
  const overheads: number[] = [];
  // Warm-up (JIT + module init) — excluded from samples.
  for (let i = 0; i < 50; i++) {
    await wrapped();
    await dummyFastCall();
  }
  for (let i = 1; i <= SAMPLES; i++) {
    const t0 = performance.now();
    await wrapped();
    const t1 = performance.now();
    const t0b = performance.now();
    await dummyFastCall();
    const t1b = performance.now();
    overheads.push((t1 - t0) - (t1b - t0b));
    if (i % 250 === 0) process.stderr.write(`  async ${i}/${SAMPLES}\n`);
  }
  return overheads;
}

/** Sync path: withResilienceSync vs raw sync call, same pairing. */
function measureSync(): number[] {
  const dummyFastCall = (): string => "ok";
  const wrapped = withResilienceSync(dummyFastCall, null);
  const overheads: number[] = [];
  for (let i = 0; i < 50; i++) {
    wrapped();
    dummyFastCall();
  }
  for (let i = 1; i <= SAMPLES; i++) {
    const t0 = performance.now();
    wrapped();
    const t1 = performance.now();
    const t0b = performance.now();
    dummyFastCall();
    const t1b = performance.now();
    overheads.push((t1 - t0) - (t1b - t0b));
  }
  return overheads;
}

//#endregion

//#region main

async function main(): Promise<void> {
  process.stderr.write(`bench-resilience-overhead: ${SAMPLES} paired samples (node ${process.version})\n`);
  const asyncOverheads = await measureAsync();
  const syncOverheads = measureSync();
  const report = {
    samples: SAMPLES,
    node: process.versions.node,
    ...summarize(asyncOverheads),
    sync_median_ms: summarize(syncOverheads).median_ms,
    sync_p95_ms: summarize(syncOverheads).p95_ms,
    note: "overhead_ms = wrapped_call - raw_call per §8.4; interim target <5ms median / <15ms p95; CI warn-only guard p95<20ms until BENCH-03 freezes budget",
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`benchmark failed: ${String(err)}\n`);
  process.exitCode = 1;
});

//#endregion
