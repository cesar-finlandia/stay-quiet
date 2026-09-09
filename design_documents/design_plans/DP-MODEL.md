# DP-MODEL — Amazon Bedrock via Strands, resilience, cost metering, context bridge

## §0 Context & blockers

Must already exist (produced by **DP-FOUND**):

* `src/stayquiet/config.py` exporting `AppConfig`, `load_app_config()`, `repo_root()`.
* `requirements.txt` installed; `from strands import Agent, tool` and
  `from strands.models import BedrockModel` verified working (DP-FOUND WU-02).
* `contracts/tokenizer-profiles.json` containing the `bedrock` profile.
* `src/stayquiet/__init__.py`, `engine/__init__.py`.

Pre-existing and read-only: `src/resilience/` (Python), `src/cost/` (Python), `src/context/`
(TypeScript). Node 20+ is on PATH.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Own every point where this application touches a model, a token budget, or the context buffer.
After this plan, exactly two functions in the whole repository construct or invoke a Strands
agent, and exactly one place applies the resilience and cost wrappers.

Requirements (blueprint §1): **SQ-F-04** (the drafting model call is a Strands tool-calling agent
on Amazon Bedrock), **SQ-F-11** (long guest threads fitted to a token budget by the context
buffer), **SQ-F-12** (token/request metering with a budget warning), **SQ-N-01** (every outbound
call wrapped by `with_resilience`, golden-cache fallback, never an exception), **SQ-N-04**
(deterministic code preferred: this plan adds no extra model call of its own).

## §2 Scope boundaries

### IN — the only files this plan creates

1. `src/stayquiet/model.py`
2. `src/stayquiet/context_bridge.py`
3. `engine/bridge/context_fit.ts`
4. `fixtures/golden/.gitkeep` (so the committed golden-cache directory exists)

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `config/stayquiet.json`, `src/stayquiet/config.py`, `contracts/tokenizer-profiles.json` | DP-FOUND |
| `src/stayquiet/seed.py`, `fixtures/synthetic/**` | DP-DATA |
| `src/stayquiet/publish.py`, `src/stayquiet/store.py`, `src/stayquiet/audit.py` | DP-STREAM |
| `engine/tools/**` | DP-TOOLS |
| `engine/agents/**`, `engine/prompts/**`, `engine/schema/**` | DP-AGENT |
| `src/stayquiet/api.py` | DP-API |
| `scripts/record_golden.py`, `fixtures/golden/*.json` (the recorded entries themselves) | DP-DEPLOY |
| anything under `src/resilience/`, `src/cost/`, `src/context/` | pre-existing modules — read-only |

`model.py` must NOT import from `engine/` (the dependency direction is `engine → src`, never the
reverse), must NOT emit event envelopes, and must NOT contain a single word of the StayQuiet
domain: no prompt text, no booking field, no policy clause. Prompts belong to DP-AGENT.

## §3 Interfaces owned

### 3.1 `src/stayquiet/model.py`

```python
# StayQuiet — the ONLY place a model is reached (blueprint §2.4 rows 9-15, §2.4c rule 2).
#
#   build_agent()  constructs the Strands agent on an Amazon Bedrock model
#   run_agent()    invokes it, wrapped by resilience (outer) and cost metering (inner)
#
# Nothing else in this repository constructs a BedrockModel, invokes a Strands
# Agent, calls boto3, or applies with_resilience / with_cost_guardrail. Domain-free
# by design: no prompt text and no booking/policy field name appears in this file.
from __future__ import annotations

import sys
from typing import Any, Optional, TypedDict

from src.resilience import (
    create_golden_cache,
    is_degraded_result,
    with_resilience,
)
from src.cost import get_default_store, with_cost_guardrail
from src.stayquiet.config import load_app_config, repo_root

#: Provider tag used for cost metering and for the tokenizer profile lookup.
PROVIDER_TAG: str = "bedrock"

#: Caller label recorded on every metered usage record.
COST_LABEL: str = "stayquiet-agent"


class LlmResult(TypedDict):
    """One completed model turn, in every outcome including failure.

    `source` is "live" for a real Bedrock turn, "cache" when the golden cache
    answered, and "none" when there was neither. `degraded` is True whenever
    source is not "live".
    """

    text: str
    degraded: bool
    reason: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    source: str  # "live" | "cache" | "none"


def result_text(result: Any) -> str:
    """Plain text of a Strands AgentResult, tolerant of every shape it may take.

    Handles: a dict message with a `content` list of `{"text": …}` blocks, a plain
    string message, and anything else via str(result). Never raises, never returns
    None; returns "" only when there was genuinely no text.
    """


def usage_from_result(result: Any) -> dict:
    """Best-effort {input_tokens, output_tokens} from a Strands AgentResult.

    Reads result.metrics.accumulated_usage, then result.metrics.get_summary()'s
    accumulated_usage, then result.usage, accepting both camelCase (inputTokens)
    and snake_case (input_tokens) keys. Missing counts come back as None — never
    guessed, never estimated here. Never raises.
    """


def usage_extractor(result: Any) -> Optional[dict]:
    """The `CostMeteringOpts.usage_extractor` hook: reads the token counts off the
    dict returned by the inner callable. Returns None when neither count is known,
    so the cost meter records the call as unmetered rather than as zero."""


def build_agent(tools: list | None = None, system_prompt: str | None = None) -> Any:
    """Construct the Strands agent for StayQuiet on an Amazon Bedrock model.

    Uses AppConfig["model_id"] and AppConfig["region"]. `tools` is the list of
    @tool callables the loop may choose from; `system_prompt` is the loop's
    instruction text. Raises only if the Strands SDK itself is unusable — that is
    a build error, not a runtime condition, and run_agent() never calls this.
    """


def run_agent(step_id: str, agent: Any, prompt: str, *, cache_key: str) -> LlmResult:
    """Invoke `agent` on `prompt` once, resiliently and metered. Never raises.

    Layering (outer to inner): with_resilience(timeout 45 s, 1 retry, exponential
    backoff, fallback chain cache → none, explicit cache key) wraps
    with_cost_guardrail(provider "bedrock", the AppConfig budget) which wraps the
    real `agent(prompt)` call. `step_id` is used only for log lines.

    Outcomes: a live turn returns source "live"; a golden-cache hit returns source
    "cache" with degraded True; exhaustion returns source "none", degraded True and
    text "" with `reason` set. AppConfig["demo_mode"] forces the cache path via the
    resilience kill switch, so the whole product runs offline unchanged.
    """


def cost_snapshot() -> dict:
    """Current usage totals for the UI and the run report.

    Returns {"total_tokens": int, "request_count": int,
             "estimated_cost_usd": float | None, "budget_tokens": int,
             "utilization": float, "warnings": list[str]}.
    `estimated_cost_usd` is a MODELLED figure from AppConfig["estimate_usd_per_1k"],
    never a bill. Never raises; on any internal error returns zeros with a warning.
    """


def record_golden(cache_key: str, text: str) -> None:
    """Write one model reply into the committed golden cache under `cache_key`, in
    the exact shape run_agent()'s cache path expects. Used by the recording script
    so the offline demo path has real content. Never raises."""


def golden_keys() -> list[str]:
    """Sorted list of the cache keys currently present in the golden cache. Used by
    the recording script to report coverage. Never raises."""
```

### 3.2 `src/stayquiet/context_bridge.py`

```python
# StayQuiet — the Python side of the context buffer (blueprint §2.4 rows 16-17).
# The buffer itself is the pre-existing TypeScript module src/context; this file
# calls it through engine/bridge/context_fit.ts in a short-lived Node process and
# degrades to a deterministic newest-first trim when Node is unavailable.
from __future__ import annotations

import json
import subprocess
import sys
from typing import TypedDict

from src.stayquiet.config import repo_root

#: Seconds to wait for the Node bridge before falling back.
BRIDGE_TIMEOUT_S: float = 20.0


class ThreadFit(TypedDict):
    """Result of fitting a message thread to a token budget."""

    messages: list[dict]  # the kept messages, oldest first, same shape as input
    dropped: int          # how many messages were evicted
    tokens: int           # token count of the kept messages
    degraded: bool        # True when the fallback trim was used instead of the buffer


def fit_thread(messages: list[dict], max_tokens: int) -> ThreadFit:
    """Fit a [{role, content}] thread into `max_tokens`, keeping the newest.

    Calls the context buffer through the Node bridge. If Node is missing, the
    bridge fails, or it does not answer within BRIDGE_TIMEOUT_S, falls back to
    _fallback_trim() and returns degraded True. Never raises.
    """


def _fallback_trim(messages: list[dict], max_tokens: int) -> ThreadFit:
    """Deterministic degraded path: keep newest messages while the running
    chars/4 estimate stays within `max_tokens`; always keep at least the last
    message. Returns degraded True."""
```

### 3.3 `engine/bridge/context_fit.ts`

```typescript
// StayQuiet — Node bridge to the pre-existing context buffer (blueprint row 17).
// Reads one JSON object from stdin: {"messages":[{"role","content"}], "maxTokens":900}
// Writes one JSON object to stdout: {"messages":[…], "dropped":N, "tokens":N}
// Exit 0 on success, 1 with a JSON {"error": "…"} on stdout on failure.
// Invoked ONLY by src/stayquiet/context_bridge.py:fit_thread().
```

## §4 Interfaces consumed

Copy these import lines verbatim.

```python
from src.resilience import create_golden_cache, is_degraded_result, with_resilience  # pre-existing resilience module
from src.cost import get_default_store, with_cost_guardrail                          # pre-existing cost module
from src.stayquiet.config import load_app_config, repo_root                          # owned by DP-FOUND
from strands import Agent                                                            # Strands Agents SDK for Python
from strands.models import BedrockModel                                              # Strands' Amazon Bedrock provider
```

In `engine/bridge/context_fit.ts`:

```typescript
import { fit } from "src/context/index.js"; // pre-existing context module
```

Nothing else. This plan does not import `seed.py`, `publish.py`, or anything from `engine/tools/`.

## §5 Algorithms and literal file contents

### §5.1 `result_text(result)`

1. `msg = getattr(result, "message", None)`.
2. If `msg` is a dict:
   1. `content = msg.get("content")`. If it is a list, return
      `"".join(b["text"] for b in content if isinstance(b, dict) and isinstance(b.get("text"), str))`.
   2. If `msg.get("text")` is a string, return it.
3. If `msg` is a string and non-empty, return `msg`.
4. Wrap everything above in `try/except Exception`; on any exception fall through.
5. Return `str(result)` if `result` is not None, else `""`.

### §5.2 `usage_from_result(result)`

1. Define `KEYS_IN = ("inputTokens", "input_tokens", "prompt_tokens")` and
   `KEYS_OUT = ("outputTokens", "output_tokens", "completion_tokens")`.
2. Collect candidate mappings, in this order, skipping anything that raises or is not a mapping:
   1. `getattr(getattr(result, "metrics", None), "accumulated_usage", None)`
   2. `getattr(result, "metrics", None).get_summary().get("accumulated_usage")` — call
      `get_summary()` only if it is callable
   3. `getattr(result, "usage", None)`
   4. `result["usage"]` when `result` is a dict
3. For the first candidate that yields at least one of the keys: return
   `{"input_tokens": <int or None>, "output_tokens": <int or None>}`, coercing with `int()` and
   turning a failed coercion into `None`.
4. If no candidate yields anything, return `{"input_tokens": None, "output_tokens": None}`.
5. The whole function is wrapped in `try/except Exception` returning the same all-`None` dict.

### §5.3 `build_agent(tools, system_prompt)`

1. `cfg = load_app_config()`.
2. `model = BedrockModel(model_id=cfg["model_id"], region_name=cfg["region"], temperature=0.2, max_tokens=1200)`.
3. `return Agent(model=model, tools=list(tools or []), system_prompt=system_prompt or "")`.
4. If `BedrockModel(...)` raises `TypeError` because a keyword is not supported by the installed
   SDK version, retry once with only `model_id=` and `region_name=`, print
   `[stayquiet] BedrockModel rejected temperature/max_tokens; using defaults` to stderr, and
   continue. Do not swallow any other exception here — an unusable SDK must fail loudly at build
   time, which is exactly what DP-FOUND WU-02 exists to catch.

### §5.4 The metered inner callable (module-level, built once)

```python
def _live_turn(agent: Any, prompt: str) -> dict:
    """The real Bedrock turn. Returns the dict shape the cache also stores."""
    result = agent(prompt)
    usage = usage_from_result(result)
    return {
        "text": result_text(result),
        "input_tokens": usage["input_tokens"],
        "output_tokens": usage["output_tokens"],
        "source": "live",
    }
```

Algorithm for the module-level metered wrapper, built lazily on first use and then reused (the
cost meter keeps per-wrapper edge-trigger state, so it must NOT be rebuilt per call):

1. `cfg = load_app_config()`.
2. Build `opts` as:
   ```python
   {
       "provider": PROVIDER_TAG,                     # "bedrock"
       "label": COST_LABEL,                          # "stayquiet-agent"
       "model_profile": "bedrock",                   # key in contracts/tokenizer-profiles.json
       "budget_config": {
           "global": {
               "budget": float(cfg["budget_tokens"]),
               "unit": "tokens",
               "threshold": float(cfg["budget_warn_at"]),
               "critical_threshold": 0.95,
               "label": "stayquiet-session",
           }
       },
       "usage_extractor": usage_extractor,
       "estimate_cost_per_1k_tokens": float(cfg["estimate_usd_per_1k"]),
       "on_warning": _on_warning,
   }
   ```
3. `_metered = with_cost_guardrail(_live_turn, opts)`; cache it in a module global.
4. `_on_warning(w)` appends `w["message"]` to a module-level `_WARNINGS: list[str]` (deduplicated)
   and prints it once to stderr. It never raises and never blocks the call.

### §5.5 `run_agent(step_id, agent, prompt, *, cache_key)`

1. `cfg = load_app_config()`.
2. `guarded = with_resilience(_metered_wrapper(), config, deps)` where
   ```python
   config = {
       "timeout_ms": 45000,
       "retries": 1,
       "backoff": {"policy": "exponential", "base_ms": 600, "factor": 2.0,
                   "max_ms": 4000, "jitter": True},
       "fallback_chain": {"order": ["cache", "none"],
                          "cache": {"enabled": True}, "none": {"enabled": True}},
       "forced_degraded": bool(cfg["demo_mode"]),
   }
   deps = {"cache_key": cache_key, "cache": _cache()}
   ```
   `_cache()` returns a module-level `create_golden_cache(str(repo_root() / cfg["golden_cache_dir"]))`,
   created once.
   Building the resilience wrapper per call is intentional and cheap: the cache key differs per
   call and resilience resolves its config once per wrapper.
3. `raw = guarded(agent, prompt)`.
4. If `is_degraded_result(raw)`: return
   `{"text": "", "degraded": True, "reason": raw["reason"], "input_tokens": None,
     "output_tokens": None, "source": "none"}`.
5. If `raw` is a dict with a string `text`:
   * `source = raw.get("source") or "live"` — a golden-cache entry carries `"cache"` because
     `record_golden()` wrote it that way, so the cache path is self-identifying.
   * return `{"text": raw["text"], "degraded": source != "live", "reason": None if source ==
     "live" else "served_from_golden_cache", "input_tokens": raw.get("input_tokens"),
     "output_tokens": raw.get("output_tokens"), "source": source}`.
6. Anything else (should be unreachable): return the step-4 shape with
   `reason="unexpected_result_shape"`.
7. Log one line per call to stderr: `[stayquiet] {step_id} source={source} tokens={in}/{out}`.

### §5.6 `cost_snapshot()`

1. `store = get_default_store()`; `cfg = load_app_config()`.
2. `t = store.global_totals()`.
3. `budget = int(cfg["budget_tokens"])`;
   `utilization = round(t["total_tokens"] / budget, 4) if budget else 0.0`.
4. Return
   `{"total_tokens": t["total_tokens"], "request_count": t["request_count"],
     "estimated_cost_usd": t["estimated_cost_usd"], "budget_tokens": budget,
     "utilization": utilization, "warnings": list(_WARNINGS)}`.
5. Wrap in `try/except Exception` returning
   `{"total_tokens": 0, "request_count": 0, "estimated_cost_usd": None,
     "budget_tokens": 0, "utilization": 0.0, "warnings": ["cost snapshot unavailable"]}`.

### §5.7 `record_golden(cache_key, text)` and `golden_keys()`

`record_golden`:
1. `_cache().put(cache_key, {"text": text, "input_tokens": None, "output_tokens": None,
   "source": "cache"}, {"provider": PROVIDER_TAG, "model": load_app_config()["model_id"],
   "source": "recorded"})`.
2. Wrap in `try/except Exception`, printing `[stayquiet] could not record {cache_key}: {err}`.

`golden_keys`:
1. `return sorted(_cache().list().keys())` inside `try/except Exception` returning `[]`.

### §5.8 `engine/bridge/context_fit.ts` — complete file

```typescript
// StayQuiet — Node bridge to the pre-existing context buffer (blueprint row 17).
// Reads one JSON object from stdin: {"messages":[{"role","content"}], "maxTokens":900}
// Writes one JSON object to stdout: {"messages":[…], "dropped":N, "tokens":N}
// Exit 0 on success; on failure writes {"error":"…"} to stdout and exits 1.
// Invoked ONLY by src/stayquiet/context_bridge.py:fit_thread().
import { fit } from "src/context/index.js";

type Wire = { messages?: Array<{ role?: string; content?: string }>; maxTokens?: number };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function main(): void {
  readStdin()
    .then((raw) => {
      const input = JSON.parse(raw || "{}") as Wire;
      const maxTokens = Number.isFinite(input.maxTokens) ? Number(input.maxTokens) : 900;
      const buffer = (input.messages ?? []).map((m) => ({
        role: (m.role === "assistant" || m.role === "system" || m.role === "tool"
          ? m.role
          : "user") as "user" | "assistant" | "system" | "tool",
        content: typeof m.content === "string" ? m.content : "",
      }));
      const out = fit(buffer, {
        model_profile: "bedrock",
        context_window: maxTokens,
        reserved_output: 0,
        strategy: "sliding-window-pinned",
        warning_threshold: 0.8,
        critical_threshold: 0.95,
      });
      process.stdout.write(
        JSON.stringify({
          messages: out.buffer.map((m) => ({ role: m.role, content: m.content })),
          dropped: out.status.evicted_count,
          tokens: out.status.total_tokens,
        }),
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stdout.write(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      );
      process.exit(1);
    });
}

main();
```

### §5.9 `fit_thread(messages, max_tokens)`

1. If `messages` is empty, return `{"messages": [], "dropped": 0, "tokens": 0, "degraded": False}`.
2. Choose the command, in this order:
   1. If `repo_root() / "dist" / "bridge" / "context_fit.mjs"` exists →
      `cmd = ["node", "dist/bridge/context_fit.mjs"]`. This is the bundled build DP-DEPLOY
      produces; it needs only a bare `node` binary and no `node_modules`, which is what the
      container has.
   2. Otherwise → `cmd = ["npx", "--yes", "vite-node", "engine/bridge/context_fit.ts"]`. This is the
      development path and needs the repository's `node_modules`.
   Run it with `subprocess.run(cmd, input=json.dumps({"messages": messages, "maxTokens":
   max_tokens}), capture_output=True, text=True, timeout=BRIDGE_TIMEOUT_S,
   cwd=str(repo_root()), shell=(sys.platform == "win32"))`.
3. If the return code is 0, parse stdout as JSON. If it has a list `messages` and integer
   `dropped` and `tokens`, return them with `degraded: False`.
4. On ANY of: `FileNotFoundError`, `subprocess.TimeoutExpired`, non-zero return code, unparsable
   stdout, or a missing key — print one stderr line
   `[stayquiet] context bridge unavailable ({reason}); using degraded trim` and return
   `_fallback_trim(messages, max_tokens)`.
5. Never raise.

`_fallback_trim(messages, max_tokens)`:
1. `kept = []`, `used = 0`.
2. Iterate `messages` in reverse. For each `m`: `cost = max(1, len(m.get("content") or "") // 4)`.
   If `kept` is empty, always keep it. Otherwise keep it only while `used + cost <= max_tokens`;
   the first message that does not fit ends the loop.
3. `kept.reverse()`.
4. Return `{"messages": kept, "dropped": len(messages) - len(kept), "tokens": used,
   "degraded": True}`.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| Bedrock unreachable / throttled / model access not granted | `run_agent` retries once, then serves the golden cache | the run completes; the envelope for that step carries `degraded: true` and the UI shows the degraded badge; `source` is `cache` |
| Golden cache also misses | `run_agent` returns `text: ""`, `source: "none"` | DP-AGENT substitutes its literal fallback draft text (its own §6) and marks the item degraded; the run still finishes |
| `demo_mode` is on | every model call is forced down the cache path | identical UI with degraded badges everywhere; used deliberately for the offline demo rung |
| Cost budget threshold crossed | nothing blocks; a warning is recorded | the warning string appears in `cost_snapshot()["warnings"]` and in the footer of the UI |
| Token counts not present in the response | the call is recorded as unmetered | request count still increases, so the budget still counts attempts; `estimated_cost_usd` may be null |
| Neither the bundled bridge nor `vite-node` is available | `fit_thread` uses the deterministic trim | the `booking_lookup` envelope reports `thread_degraded: true`; drafts are still grounded in the newest messages |
| `contracts/tokenizer-profiles.json` missing | offline token estimates get less accurate | a `[COST] unknown model_profile` warning; nothing crashes |

## §7 Work units

### WU-MODEL-01 — Result readers

**Goal.** Extract text and token counts from a Strands result without depending on one SDK shape.

**Steps.**
1. Create `src/stayquiet/model.py` with the header comment, imports and constants of §3.1.
2. Add `LlmResult`, `result_text()` (§5.1), `usage_from_result()` (§5.2) and
   `usage_extractor()` (returns `None` when both counts are `None`, else the two keys).
3. Add nothing else yet.

**Files created.** `src/stayquiet/model.py` (partial).

**Verification command.**
```bash
python -c "
from src.stayquiet.model import result_text, usage_from_result, usage_extractor
class R:
    message = {'role':'assistant','content':[{'text':'Hello '},{'text':'Maya.'}]}
    class metrics: accumulated_usage = {'inputTokens': 812, 'outputTokens': 190}
print(repr(result_text(R())), usage_from_result(R()))
print(result_text('plain'), usage_from_result(object()))
print(usage_extractor({'input_tokens': 3, 'output_tokens': 4}), usage_extractor({'input_tokens': None, 'output_tokens': None}))
"
```
**Expected output.**
```
'Hello Maya.' {'input_tokens': 812, 'output_tokens': 190}
plain {'input_tokens': None, 'output_tokens': None}
{'input_tokens': 3, 'output_tokens': 4} None
```
**What it proves.** Both readers handle the real Strands shape, an unexpected shape, and a
missing-usage response without raising — so a minor SDK difference cannot break the cycle.

---

### WU-MODEL-02 — The Strands agent factory

**Goal.** One function that builds the agent on Amazon Bedrock from `AppConfig`.

**Steps.**
1. Add `build_agent()` implementing §5.3.
2. Do not call it at import time. Do not construct a model anywhere else.

**Files modified.** `src/stayquiet/model.py`.

**Verification command.**
```bash
python -c "
from src.stayquiet.model import build_agent
from src.stayquiet.config import load_app_config
a = build_agent(tools=[], system_prompt='You are a test.')
print(type(a).__name__, load_app_config()['model_id'])
"
```
**Expected output.**
```
Agent global.anthropic.claude-sonnet-4-6
```
**What it proves.** A real Strands `Agent` is constructed against the configured Bedrock model id
— the mandated technology is wired to the configuration surface, with no network call yet.

---

### WU-MODEL-03 — Resilient, metered invocation

**Goal.** `run_agent()` with the resilience → cost → Bedrock layering and the golden-cache path.

**Steps.**
1. Add `_live_turn()` (§5.4), the lazily-built metered wrapper (§5.4), `_on_warning()`,
   `_cache()`, `run_agent()` (§5.5), `cost_snapshot()` (§5.6), `record_golden()` and
   `golden_keys()` (§5.7).
2. Create the directory `fixtures/golden/` with an empty `.gitkeep` file so the committed cache
   directory exists before DP-DEPLOY records into it.
3. Never let an exception escape `run_agent`.

**Files created/modified.** `src/stayquiet/model.py`, `fixtures/golden/.gitkeep`.

**Verification command.**
```bash
STAYQUIET_DEMO_MODE=1 python -c "
from src.stayquiet.model import record_golden, run_agent, cost_snapshot, golden_keys
record_golden('wu-model-03-probe', 'Cached reply for the probe.')
class FakeAgent:
    def __call__(self, prompt): raise RuntimeError('bedrock must not be called in demo mode')
r = run_agent('draft_reply', FakeAgent(), 'anything', cache_key='wu-model-03-probe')
print(r['source'], r['degraded'], r['reason'], repr(r['text']))
m = run_agent('draft_reply', FakeAgent(), 'anything', cache_key='no-such-key')
print(m['source'], m['degraded'], repr(m['text']))
print('keys', 'wu-model-03-probe' in golden_keys(), 'requests', cost_snapshot()['request_count'])
"
```
**Expected output.**
```
cache True served_from_golden_cache 'Cached reply for the probe.'
none True ''
keys True requests 0
```
**What it proves.** The full wrapper stack works with no AWS credentials at all: `demo_mode`
forces the cache path, a hit is reported as degraded with the recorded text, a miss degrades
cleanly to empty text instead of raising, and the cost store is reachable. This exercises the real
`src.resilience` and `src.cost` imports (blueprint rows C1–C4).

---

### WU-MODEL-04 — Context bridge

**Goal.** Fit a long guest thread with the pre-existing context buffer, from Python.

**Steps.**
1. Create `engine/bridge/context_fit.ts` with the literal contents of §5.8.
2. Create `src/stayquiet/context_bridge.py` with §3.2's skeleton and §5.9's algorithms.
3. Do not add a token counter, a truncation strategy or a tokenizer here — the buffer owns all
   three. `_fallback_trim` is a length-based last resort and says so by returning
   `degraded: True`.

**Files created.** `engine/bridge/context_fit.ts`, `src/stayquiet/context_bridge.py`.

**Verification command.**
```bash
python -c "
from src.stayquiet.context_bridge import fit_thread, _fallback_trim
msgs = [{'role':'user','content':'word '*80} for _ in range(14)]
r = fit_thread(msgs, 900)
print('kept', len(r['messages']), 'dropped', r['dropped'], 'within', r['tokens'] <= 900, 'degraded', r['degraded'])
f = _fallback_trim(msgs, 900)
print('fallback kept', len(f['messages']), 'dropped', f['dropped'], f['degraded'])
"
```
**Expected output.**
```
kept 8 dropped 6 within True degraded False
fallback kept 8 dropped 6 True
```
**What it proves.** A 14-message thread is fitted to the 900-token budget by the real context
buffer through the Node bridge (a genuine provider→consumer call across the language boundary),
and the degraded trim keeps the same newest-first behaviour when Node is absent.

> If the bridge is unavailable on the build machine, the first line prints
> `degraded True` and different `kept`/`dropped` numbers. That is an acceptable
> pass **only** if the second line is correct and the stderr warning
> `[stayquiet] context bridge unavailable` appeared: record it in the run report so
> DP-DEPLOY knows the container must include Node. Everything else in this plan
> must still pass.

---

## §8 Verification summary

```bash
# WU-MODEL-01
python -c "
from src.stayquiet.model import result_text, usage_from_result, usage_extractor
class R:
    message={'role':'assistant','content':[{'text':'Hello '},{'text':'Maya.'}]}
    class metrics: accumulated_usage={'inputTokens':812,'outputTokens':190}
print(repr(result_text(R())), usage_from_result(R()))
print(result_text('plain'), usage_from_result(object()))
print(usage_extractor({'input_tokens':3,'output_tokens':4}), usage_extractor({'input_tokens':None,'output_tokens':None}))"
# WU-MODEL-02
python -c "
from src.stayquiet.model import build_agent
from src.stayquiet.config import load_app_config
a=build_agent(tools=[], system_prompt='You are a test.')
print(type(a).__name__, load_app_config()['model_id'])"
# WU-MODEL-03
STAYQUIET_DEMO_MODE=1 python -c "
from src.stayquiet.model import record_golden, run_agent, cost_snapshot, golden_keys
record_golden('wu-model-03-probe','Cached reply for the probe.')
class FakeAgent:
    def __call__(self, prompt): raise RuntimeError('bedrock must not be called in demo mode')
r=run_agent('draft_reply', FakeAgent(), 'anything', cache_key='wu-model-03-probe')
print(r['source'], r['degraded'], r['reason'], repr(r['text']))
m=run_agent('draft_reply', FakeAgent(), 'anything', cache_key='no-such-key')
print(m['source'], m['degraded'], repr(m['text']))
print('keys', 'wu-model-03-probe' in golden_keys(), 'requests', cost_snapshot()['request_count'])"
# WU-MODEL-04
python -c "
from src.stayquiet.context_bridge import fit_thread, _fallback_trim
msgs=[{'role':'user','content':'word '*80} for _ in range(14)]
r=fit_thread(msgs, 900)
print('kept', len(r['messages']), 'dropped', r['dropped'], 'within', r['tokens']<=900, 'degraded', r['degraded'])
f=_fallback_trim(msgs, 900)
print('fallback kept', len(f['messages']), 'dropped', f['dropped'], f['degraded'])"
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| The installed Strands version returns a different `AgentResult` shape | `result_text` and `usage_from_result` accept four shapes each and never raise; WU-01's verification exercises two of them explicitly |
| `BedrockModel` rejects `temperature`/`max_tokens` | §5.3 step 4 retries with the minimal keyword set and warns |
| A cache hit is mistaken for a live turn | the cached payload carries `"source": "cache"`, written by `record_golden()` — the only writer — so the distinction is data, not inference |
| The cost wrapper is rebuilt per call and loses its warning edge-trigger | §5.4 step 3 builds it once into a module global; §5.5 builds only the resilience wrapper per call, and says why |
| `npx vite-node` is slow enough to stall a cycle | `BRIDGE_TIMEOUT_S = 20` plus the deterministic fallback; the bridge is called once per affected booking (four times per cycle with the shipped fixtures) |
| Someone adds a prompt string to `model.py` | §2 forbids domain content here; prompts are DP-AGENT's files, and `model.py` takes `prompt` as an argument |
| Estimated cost read as a bill | every surface calls it modelled: the docstring, `cost_snapshot`'s comment, DP-FOUND's key table, and DP-SCRIPT's fact ledger |
