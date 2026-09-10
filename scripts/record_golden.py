# StayQuiet — record the golden cache so the product runs with no credentials.
#
#   python scripts/record_golden.py            # record every affected booking
#   python scripts/record_golden.py --check    # report coverage, record nothing
#
# How it works: run the real cycle LIVE (so every draft and checklist is a genuine
# Amazon Bedrock answer), then write each result back into the golden cache under the
# exact key run_agent() will look for offline. The keys are
#   draft::<booking_id>::<latest_captured_at>
#   checklist::<booking_id>::<latest_captured_at>
# and they are derived here from the CycleResult, never typed by hand.
#
# Run this ONCE after the fixtures are final and before recording the video. The
# entries it writes are committed: fixtures/golden/ is what makes the degraded-live
# demo rung real rather than theoretical.
from __future__ import annotations

import json
import sys

from engine.agents import run_cycle
from src.stayquiet.config import load_app_config
from src.stayquiet.model import golden_keys, record_golden


def main(argv: list[str]) -> int:
    cfg = load_app_config()
    if "--check" in argv:
        keys = golden_keys()
        print(f"golden cache: {len(keys)} entr{'y' if len(keys) == 1 else 'ies'}")
        for k in keys:
            print(" ", k)
        return 0

    if cfg["demo_mode"]:
        print("[record] demo_mode is on — nothing to record. Unset STAYQUIET_DEMO_MODE "
              "and provide AWS credentials, then run again.", file=sys.stderr)
        return 1

    result = run_cycle()
    stamp = result["latest_captured_at"]
    written = 0
    skipped = 0

    for d in result["drafts"]:
        if d["source"] != "live" or not d["text"].strip():
            skipped += 1
            continue
        record_golden(f"draft::{d['booking_id']}::{stamp}", d["text"])
        written += 1

    for c in result["checklists"]:
        if c["source"] != "live" or not c["items"]:
            skipped += 1
            continue
        record_golden(f"checklist::{c['booking_id']}::{stamp}",
                      "\n".join(f"- {i}" for i in c["items"]))
        written += 1

    print(json.dumps({
        "recorded": written,
        "skipped_not_live": skipped,
        "policy_stamp": stamp,
        "bookings_affected": result["bookings_affected"],
        "tokens": result["tokens"],
        "keys": golden_keys(),
    }, indent=2))
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
