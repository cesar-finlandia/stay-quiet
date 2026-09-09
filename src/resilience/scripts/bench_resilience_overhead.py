# Requirement IDs: RES-RES-01, XCUT-08
# Latency-overhead benchmark (DP-A §8.4 / §10.5).
#
#   python src/resilience/scripts/bench_resilience_overhead.py
#
# Measures per-call overhead of the resilience wrapper on the success path
# (no retry, no fallback): wrapped `dummy_fast_call` vs raw call, 1000 paired
# iterations; overhead_i = wrapped_i - raw_i. Reports median/p95/p99/mean for
# async (with_resilience) and sync paths and prints JSON.
#
# Domain-free (GOV-REU-02); stdlib only (RES-REU-01); zero deps.

import json
import math
import statistics
import sys
import time

sys.path.insert(0, ".")  # repo root, so `src.resilience` is importable

SAMPLES = 1000


def percentile(sorted_vals, p):
    """Nearest-rank percentile of a pre-sorted sample."""
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, max(0, math.ceil((p / 100) * len(sorted_vals)) - 1))
    return sorted_vals[idx]


def summarize(overheads_ms):
    """median/p95/p99/mean over a list of per-pair overheads (ms)."""
    ordered = sorted(overheads_ms)
    return {
        "median_ms": round3(percentile(ordered, 50)),
        "p95_ms": round3(percentile(ordered, 95)),
        "p99_ms": round3(percentile(ordered, 99)),
        "mean_ms": round3(statistics.fmean(ordered) if ordered else 0.0),
    }


def round3(v):
    return round(v, 3)


def measure_async(with_resilience):
    """Paired loop per §8.4: async dummy wrapped vs raw, overhead = wrapped - raw."""
    from src.resilience import with_resilience as _wr  # noqa: F401  (import shape check)

    async def dummy_fast_call():
        return "ok"

    wrapped = with_resilience(dummy_fast_call, None)
    import asyncio

    async def run_pair(_w, _raw):
        t0 = time.perf_counter()
        await _w()
        t1 = time.perf_counter()
        t0b = time.perf_counter()
        await _raw()
        t1b = time.perf_counter()
        return (t1 - t0) * 1000.0 - ((t1b - t0b) * 1000.0)

    async def drive():
        for _ in range(50):  # warm-up
            await wrapped()
            await dummy_fast_call()
        overheads = []
        for i in range(1, SAMPLES + 1):
            overheads.append(await run_pair(wrapped, dummy_fast_call))
            if i % 250 == 0:
                sys.stderr.write(f"  async {i}/{SAMPLES}\n")
        return overheads

    return asyncio.run(drive())


def measure_sync(with_resilience):
    """Sync path: sync dummy wrapped vs raw call, same pairing."""
    def dummy_fast_call():
        return "ok"

    wrapped = with_resilience(dummy_fast_call, None)
    for _ in range(50):  # warm-up
        wrapped()
        dummy_fast_call()
    overheads = []
    for _ in range(SAMPLES):
        t0 = time.perf_counter()
        wrapped()
        t1 = time.perf_counter()
        t0b = time.perf_counter()
        dummy_fast_call()
        t1b = time.perf_counter()
        overheads.append((t1 - t0) * 1000.0 - ((t1b - t0b) * 1000.0))
    return overheads


def main():
    from src.resilience import with_resilience

    sys.stderr.write(f"bench_resilience_overhead: {SAMPLES} paired samples\n")
    async_overheads = measure_async(with_resilience)
    sync_overheads = measure_sync(with_resilience)
    report = {
        "samples": SAMPLES,
        **summarize(async_overheads),
        "sync_median_ms": summarize(sync_overheads)["median_ms"],
        "sync_p95_ms": summarize(sync_overheads)["p95_ms"],
        "note": "overhead_ms = wrapped_call - raw_call per §8.4; interim target <5ms median / <15ms p95; CI warn-only guard p95<20ms until BENCH-03 freezes budget",
    }
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
