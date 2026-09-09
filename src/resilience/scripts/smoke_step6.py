# Smoke mirroring DP-A §10.4 (RES-AC-03): one repair, then fallback. Not an acceptance test (step 7 owns those).
import asyncio
import json
import sys

from src.resilience import with_validation, is_degraded_result

SCHEMA = {
    "type": "object",
    "required": ["title", "score"],
    "properties": {"title": {"type": "string"}, "score": {"type": "number"}},
}


async def main() -> int:
    # Case 1 (§10.4 mirror, async primary + async repair LLM): malformed output,
    # repair fixes it -> repaired value returned, EXACTLY ONE repair call.
    calls = {"n": 0}

    async def repair_llm_good_async(_prompt: str) -> str:
        calls["n"] += 1
        return json.dumps({"title": "Acme widget", "score": 42})

    async def malformed_async() -> str:
        return json.dumps({"title": "Acme widget", "score": "not a number"})

    wrapped = with_validation(
        malformed_async,
        SCHEMA,
        {"timeout_ms": 1000, "retries": 1, "fallback_chain": {"order": ["none"]}},
        {"repair_llm": repair_llm_good_async},
    )
    result = await wrapped()
    assert result == {"title": "Acme widget", "score": 42}, f"case1 unexpected: {result!r}"
    assert calls["n"] == 1, f"case1 repair called {calls['n']} times, expected 1"
    print("case1 OK: repaired value returned; repairLlm called exactly once")

    # Case 2 (§10.4 mirror): repair LLM returns garbage ->
    # DegradedResult(validation_repair_failed), never a thrown error.
    def repair_llm_garbage(_prompt: str) -> str:
        return "still not json"

    async def bad_async() -> str:
        return "bad"

    wrapped2 = with_validation(
        bad_async,
        SCHEMA,
        {"timeout_ms": 1000, "retries": 3, "fallback_chain": {"order": ["none"]}},
        {"repair_llm": repair_llm_garbage},
    )
    result2 = await wrapped2()
    assert is_degraded_result(result2), f"case2 expected DegradedResult, got {result2!r}"
    assert result2["reason"] == "validation_repair_failed", f"case2 reason={result2['reason']!r}"
    print("case2 OK: DegradedResult with reason 'validation_repair_failed' (no throw despite retries=3)")

    # Case 3: SYNC target + SYNC repair_llm -> repaired value returned directly
    # from the sync wrapper (no leaked coroutine; caller never awaits internals).
    calls3 = {"n": 0}

    def repair_llm_good_sync(_prompt: str) -> str:
        calls3["n"] += 1
        return json.dumps({"title": "Acme widget", "score": 7})

    def malformed_sync() -> str:
        return json.dumps({"title": "Acme widget", "score": "oops"})

    wrapped3 = with_validation(
        malformed_sync,
        SCHEMA,
        {"timeout_ms": 1000, "retries": 2, "fallback_chain": {"order": ["none"]}},
        {"repair_llm": repair_llm_good_sync},
    )
    result3 = wrapped3()  # plain call — sync wrapper must NOT return a coroutine
    assert not asyncio.iscoroutine(result3), "case3 leaked an internal coroutine"
    assert result3 == {"title": "Acme widget", "score": 7}, f"case3 unexpected: {result3!r}"
    assert calls3["n"] == 1, f"case3 repair called {calls3['n']} times, expected 1"
    print("case3 OK: sync target + sync repairLlm -> repaired value, exactly one call, no coroutine leak")

    # Case 4: SYNC target + garbage repair_llm -> DegradedResult, never throws.
    wrapped4 = with_validation(
        lambda: "bad",
        SCHEMA,
        {"timeout_ms": 1000, "retries": 5, "fallback_chain": {"order": ["none"]}},
        {"repair_llm": repair_llm_garbage},
    )
    result4 = wrapped4()
    assert not asyncio.iscoroutine(result4), "case4 leaked an internal coroutine"
    assert is_degraded_result(result4), f"case4 expected DegradedResult, got {result4!r}"
    assert result4["reason"] == "validation_repair_failed", f"case4 reason={result4['reason']!r}"
    print("case4 OK: sync target + garbage repair -> DegradedResult 'validation_repair_failed', no throw")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
