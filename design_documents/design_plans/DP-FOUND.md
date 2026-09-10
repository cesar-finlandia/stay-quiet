# DP-FOUND — Runtime foundations, configuration and licence

## §0 Context & blockers

Before WU-FOUND-01 runs, all of this already exists in the repository and must NOT be recreated:

* `src/resilience/` (Python + TS), `src/cost/` (Python), `src/context/` (TypeScript),
  `src/data/` (TypeScript), `src/platform/` (transport/ui/deploy), `src/provenance/` (Python + TS).
* `contracts/event-envelope.schema.json`, `contracts/degraded-result.schema.json`,
  `contracts/message.schema.json`, `contracts/context-budget.schema.json`,
  `contracts/component-catalog.json`, `contracts/assembly-manifest.schema.json`.
* `config/model-profiles.json`, `config/transport.json`, `config/env.example`,
  `config/deploy/*`, `assembly.manifest.json`.
* `engine/` with `TODO(ENGINE)` stubs, `package.json`, `tsconfig.json`, `vite.config.ts`,
  `index.html`, `.gitignore`, `.nvmrc` (`20`), `.python-version` (`3.11`).

Blockers: none. This is the first plan; nothing depends on anything unwritten.

Required tooling on the machine: Python 3.11+ (`python --version`), Node 20+ (`node --version`),
`pip`, `npm`. On Windows use PowerShell or Git Bash; every command below is written for a POSIX
shell and works unchanged in Git Bash.

**Working directory for every command in this plan is the entry repository root** (the directory
containing `assembly.manifest.json`).

## §1 Purpose & requirement IDs

Make the repository runnable as a Python 3.11 + Node 20 application, give it one configuration
surface, and give it the licence the rules demand.

Requirements fulfilled (blueprint §1): **SQ-F-14** (repo ships `LICENSE`), **SQ-N-06** (no secret
committed; app starts with zero secrets), **SQ-N-08** (Python 3.11+/Node 20+, one
`pip install -r requirements.txt` and one `npm install`).

## §2 Scope boundaries

### IN — the only files this plan creates or modifies

1. `requirements.txt` (create)
2. `pyproject.toml` (replace wholesale)
3. `contracts/tokenizer-profiles.json` (create)
4. `LICENSE` (create)
5. `.env.example` (create at repo root)
6. `config/stayquiet.json` (create)
7. `src/stayquiet/__init__.py` (create)
8. `src/stayquiet/config.py` (create)
9. `engine/__init__.py` (already exists as `engine/agents/__init__.py` only — create the
   package marker `engine/__init__.py`)
10. `engine/tools/__init__.py` (create, placeholder — DP-TOOLS replaces its body)
11. `src/index.ts` (replace wholesale — it currently re-exports barrels that do not exist)
12. `README.md` — **only** the two-line placeholder in WU-FOUND-04; the real README is DP-SUBMIT's

### OUT — files owned elsewhere; never create or edit them here

| File | Owner |
|---|---|
| `fixtures/synthetic/**`, `src/stayquiet/seed.py`, `scripts/generate_fixtures.mjs` | DP-DATA |
| `src/stayquiet/model.py`, `src/stayquiet/context_bridge.py`, `engine/bridge/context_fit.ts` | DP-MODEL |
| `src/stayquiet/publish.py`, `src/stayquiet/store.py`, `src/stayquiet/audit.py` | DP-STREAM |
| `engine/tools/*.py` (bodies) | DP-TOOLS |
| `engine/agents/stayquiet_agent.py`, `engine/agents/__init__.py`, `engine/prompts/*.md`, `engine/schema/*.json` | DP-AGENT |
| `src/stayquiet/api.py`, `src/stayquiet/__main__.py` | DP-API |
| `index.html`, `src/stayquiet/web/**`, `vite.config.ts` | DP-UI |
| `Dockerfile`, `scripts/deploy-apprunner.sh`, `scripts/smoke.sh`, `scripts/record_golden.py`, `deploy/**` | DP-DEPLOY |
| `README.md` (real content), `docs/architecture.*`, `disclosure.md`, `ai_tools.json` | DP-SUBMIT |
| anything under `src/resilience/`, `src/cost/`, `src/context/`, `src/data/`, `src/platform/`, `src/provenance/` | pre-existing modules — read-only |

## §3 Interfaces owned

### 3.1 `src/stayquiet/config.py`

```python
# StayQuiet — the ONE configuration surface (blueprint §2.5, contract rows 1-2).
# Every other module calls load_app_config(); no other file opens
# config/stayquiet.json and no other file hardcodes a value that lives in it.
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import TypedDict

APP_CONFIG_PATH: str = "config/stayquiet.json"


class AppConfig(TypedDict):
    """Fully-resolved application configuration. Every key is always present."""

    model_id: str
    region: str
    demo_mode: bool
    cycle_interval_s: int
    fixtures_dir: str
    golden_cache_dir: str
    max_bookings: int
    thread_token_budget: int
    budget_tokens: int
    budget_warn_at: float
    estimate_usd_per_1k: float
    escalate_refund_over_eur: float


DEFAULTS: AppConfig = { ... }  # literal value in §5.1


def repo_root() -> Path:
    """Absolute path of the repository root (the parent of src/)."""


def load_app_config(path: str | None = None) -> AppConfig:
    """Read config/stayquiet.json, apply env overrides, return a complete AppConfig.

    Never raises: a missing, unreadable or malformed file prints one warning to
    stderr and returns DEFAULTS. Unknown keys in the file are ignored. Result is
    cached after the first call; pass an explicit path to bypass the cache.
    """
```

### 3.2 `src/stayquiet/__init__.py`

```python
# StayQuiet application package. Import surface for the app's own modules.
# Nothing is re-exported here on purpose: consumers import the concrete module
# (src.stayquiet.config, src.stayquiet.seed, …) so ownership stays obvious.
```

### 3.3 `engine/__init__.py`

```python
# StayQuiet engine package: the Strands agent loop, its tools, and its prompts.
```

### 3.4 `engine/tools/__init__.py` (placeholder created here, final body owned by DP-TOOLS)

```python
# StayQuiet Strands tools. DP-TOOLS replaces this body with the real six-tool
# export; the placeholder exists so `import engine.tools` succeeds from WU-01 on.
ALL_TOOLS: list = []
```

## §4 Interfaces consumed

This plan consumes **nothing from other plans** (it is first). It verifies that these
pre-existing imports work, using exactly these lines:

```python
from src.resilience import with_resilience, is_degraded_result, create_golden_cache  # pre-existing resilience module
from src.cost import with_cost_guardrail, get_default_store                          # pre-existing cost module
from src.platform.transport.event_envelope import EventEnvelope                      # pre-existing platform/transport
```

```python
from strands import Agent, tool          # Strands Agents SDK for Python — the mandated technology
from strands.models import BedrockModel  # Strands' Amazon Bedrock model provider
```

## §5 Literal file contents

### §5.1 `src/stayquiet/config.py` — complete file

```python
# StayQuiet — the ONE configuration surface (blueprint §2.5, contract rows 1-2).
# Every other module calls load_app_config(); no other file opens
# config/stayquiet.json and no other file hardcodes a value that lives in it.
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional, TypedDict

APP_CONFIG_PATH: str = "config/stayquiet.json"


class AppConfig(TypedDict):
    """Fully-resolved application configuration. Every key is always present."""

    model_id: str
    region: str
    demo_mode: bool
    cycle_interval_s: int
    fixtures_dir: str
    golden_cache_dir: str
    max_bookings: int
    thread_token_budget: int
    budget_tokens: int
    budget_warn_at: float
    estimate_usd_per_1k: float
    escalate_refund_over_eur: float


DEFAULTS: AppConfig = {
    "model_id": "global.anthropic.claude-sonnet-4-6",
    "region": "us-west-2",
    "demo_mode": False,
    "cycle_interval_s": 900,
    "fixtures_dir": "fixtures/synthetic",
    "golden_cache_dir": "fixtures/golden",
    "max_bookings": 6,
    "thread_token_budget": 900,
    "budget_tokens": 400000,
    "budget_warn_at": 0.8,
    "estimate_usd_per_1k": 0.006,
    "escalate_refund_over_eur": 0.0,
}

_cached: Optional[AppConfig] = None


def repo_root() -> Path:
    """Absolute path of the repository root (the parent of src/)."""
    return Path(__file__).resolve().parents[2]


def _as_bool(raw: str) -> bool:
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _apply_env(cfg: AppConfig) -> AppConfig:
    """Env overrides listed in blueprint §2.5. Malformed values are ignored."""
    if os.environ.get("STAYQUIET_MODEL_ID"):
        cfg["model_id"] = os.environ["STAYQUIET_MODEL_ID"]
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if region:
        cfg["region"] = region
    if os.environ.get("STAYQUIET_DEMO_MODE") is not None:
        cfg["demo_mode"] = _as_bool(os.environ["STAYQUIET_DEMO_MODE"])
    if os.environ.get("STAYQUIET_CYCLE_INTERVAL_S"):
        try:
            cfg["cycle_interval_s"] = max(5, int(os.environ["STAYQUIET_CYCLE_INTERVAL_S"]))
        except ValueError:
            print("[stayquiet] STAYQUIET_CYCLE_INTERVAL_S is not an integer; keeping default",
                  file=sys.stderr)
    if os.environ.get("GOLDEN_CACHE_DIR"):
        cfg["golden_cache_dir"] = os.environ["GOLDEN_CACHE_DIR"]
    return cfg


def load_app_config(path: str | None = None) -> AppConfig:
    """Read config/stayquiet.json, apply env overrides, return a complete AppConfig.

    Never raises: a missing, unreadable or malformed file prints one warning to
    stderr and returns DEFAULTS. Unknown keys in the file are ignored. Result is
    cached after the first call; pass an explicit path to bypass the cache.
    """
    global _cached
    if path is None and _cached is not None:
        return _cached
    cfg: AppConfig = dict(DEFAULTS)  # type: ignore[assignment]
    target = Path(path) if path else (repo_root() / APP_CONFIG_PATH)
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("root is not a JSON object")
        for key in DEFAULTS:
            if key in raw and isinstance(raw[key], type(DEFAULTS[key])):  # type: ignore[literal-required]
                cfg[key] = raw[key]  # type: ignore[literal-required]
    except FileNotFoundError:
        print(f"[stayquiet] {target} not found; using built-in defaults", file=sys.stderr)
    except Exception as err:  # noqa: BLE001 — configuration must never crash the app
        print(f"[stayquiet] {target} unreadable ({err}); using built-in defaults", file=sys.stderr)
    cfg = _apply_env(cfg)
    # Environment always wins for the cache dir the resilience layer reads.
    os.environ.setdefault("GOLDEN_CACHE_DIR", str(repo_root() / cfg["golden_cache_dir"]))
    if path is None:
        _cached = cfg
    return cfg
```

Note on the `isinstance(raw[key], type(DEFAULTS[key]))` guard: `budget_warn_at`,
`estimate_usd_per_1k` and `escalate_refund_over_eur` default to floats, so a JSON integer such as
`1` would be rejected. Write those three values in `config/stayquiet.json` **with a decimal
point** (`0.8`, `0.006`, `0.0`) — §5.2 already does.

### §5.2 `config/stayquiet.json` — complete file

```json
{
  "$comment": "StayQuiet application configuration — the single knob surface (blueprint §2.5). Env overrides: STAYQUIET_MODEL_ID, AWS_REGION, STAYQUIET_DEMO_MODE, STAYQUIET_CYCLE_INTERVAL_S, GOLDEN_CACHE_DIR.",
  "model_id": "global.anthropic.claude-sonnet-4-6",
  "region": "us-west-2",
  "demo_mode": false,
  "cycle_interval_s": 900,
  "fixtures_dir": "fixtures/synthetic",
  "golden_cache_dir": "fixtures/golden",
  "max_bookings": 6,
  "thread_token_budget": 900,
  "budget_tokens": 400000,
  "budget_warn_at": 0.8,
  "estimate_usd_per_1k": 0.006,
  "escalate_refund_over_eur": 0.0
}
```

Meaning of each key, so no implementor guesses:

| Key | Meaning |
|---|---|
| `model_id` | Bedrock model id passed to Strands' `BedrockModel` |
| `region` | AWS region for Bedrock |
| `demo_mode` | `true` = never call Bedrock; serve every model step from the golden cache and mark it degraded |
| `cycle_interval_s` | seconds between background cycles (demo uses `STAYQUIET_CYCLE_INTERVAL_S=30`) |
| `fixtures_dir` | directory holding the synthetic bookings/policy snapshots |
| `golden_cache_dir` | directory holding recorded model replies (committed, so the offline demo works) |
| `max_bookings` | hard cap on bookings processed per cycle (cost guard) |
| `thread_token_budget` | token budget the context buffer fits a guest thread into |
| `budget_tokens` | total-token budget for the cost guardrail |
| `budget_warn_at` | fraction of `budget_tokens` at which a warning fires |
| `estimate_usd_per_1k` | **modelled** blended USD per 1 000 tokens used for the cost estimate — not a bill |
| `escalate_refund_over_eur` | any draft implying a refund above this amount must be escalated to the host; `0.0` means every refund is escalated |

### §5.3 `requirements.txt` — complete file

```
# StayQuiet runtime dependencies (Python 3.11+).
# Mandated technology: the Strands Agents SDK for Python.
strands-agents>=1.0,<2.0
boto3>=1.35
fastapi>=0.115
uvicorn[standard]>=0.30
jsonschema>=4.21
typing_extensions>=4.13
```

### §5.4 `pyproject.toml` — complete replacement file

The version in the repository declares console scripts for packages that are not present
(`assembly`, `mock`, `eval`, `doctor`, `pgm`, `profile`, `track`, `bench`) and a
`packages.find` include list of directories that do not exist, so any `pip install .` fails.
StayQuiet is run from the repository root and never installed, so this file keeps only project
metadata and the pytest setting.

```toml
# StayQuiet — an AI agent for independent short-stay hosts, built with the
# Strands Agents SDK for Python on Amazon Bedrock.
# Runtime deps live in requirements.txt; the app runs from the repository root
# (`python -m src.stayquiet`) and is never pip-installed, so no packages are
# declared and no console scripts are registered here.
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "stayquiet"
version = "1.0.0"
description = "Background agent for independent short-stay hosts, built with the Strands Agents SDK on Amazon Bedrock"
requires-python = ">=3.11"
license = { text = "MIT" }
dynamic = ["dependencies"]

[tool.setuptools.dynamic]
dependencies = { file = ["requirements.txt"] }

[tool.setuptools]
py-modules = []

[tool.pytest.ini_options]
addopts = "--import-mode=importlib"
```

### §5.5 `contracts/tokenizer-profiles.json` — complete file

The token counter and the cost meter both read `contracts/tokenizer-profiles.json`; it is absent
from this repository, so both silently fall back to an empty profile map. This file supplies the
map and adds the `bedrock` profile this entry uses.

```json
{
  "$id": "https://stayquiet/contracts/tokenizer-profiles.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "version": "1.0.0",
  "description": "model_profile → tokenizer mapping, read by the token counter and the cost meter. Adding a profile is a minor change; renaming or removing one is breaking.",
  "profiles": {
    "generic-heuristic": {
      "tokenizer": "heuristic",
      "context_window": 8192,
      "notes": "Chars/4 approximation. Dependency-free default."
    },
    "bedrock": {
      "tokenizer": "anthropic-heuristic",
      "context_window": 200000,
      "notes": "Amazon Bedrock Anthropic Claude family as reached through the Strands BedrockModel provider. Heuristic offline count; real token counts come from the provider usage block when available."
    },
    "gpt-4o-mini": {
      "tokenizer": "cl100k-heuristic",
      "context_window": 128000,
      "notes": "Used only by the build-time synthetic-data generator."
    },
    "gpt-4o": {
      "tokenizer": "cl100k-heuristic",
      "context_window": 128000,
      "notes": "Used only by the build-time document/pitch tooling."
    }
  },
  "default_profile": "generic-heuristic"
}
```

### §5.6 `LICENSE` — complete file

The rules require an MIT or Apache licence file "detectable and visible at the top of the
repository page (in the About section)". GitHub detects a file named exactly `LICENSE`
containing the unmodified MIT text.

```
MIT License

Copyright (c) 2026 StayQuiet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Replace `StayQuiet` in the copyright line with the entrant's own name before the repository is
made public if the entrant prefers; the licence text itself must not be altered.

### §5.7 `.env.example` — complete file (repo root; `config/env.example` stays as it is)

```
# StayQuiet — copy to .env and fill. NEVER commit .env (.gitignore already blocks it).
# The application starts and runs a full cycle with NONE of these set: it falls back
# to offline demo mode from the committed golden cache.

# --- AWS (needed only for live Amazon Bedrock inference) -------------------
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
AWS_REGION=us-west-2

# --- StayQuiet knobs (all optional; defaults in config/stayquiet.json) -----
STAYQUIET_MODEL_ID=global.anthropic.claude-sonnet-4-6
STAYQUIET_DEMO_MODE=0
STAYQUIET_CYCLE_INTERVAL_S=900
PORT=8080

# --- Deploy (needed only for scripts/deploy-apprunner.sh) -----------------
AWS_ACCOUNT_ID=
ECR_REPOSITORY=stayquiet
PUBLIC_URL=

# --- Build-time only: regenerating synthetic fixtures or pitch artifacts ---
OPENAI_API_KEY=
```

### §5.8 `src/index.ts` — complete replacement file

The current file re-exports `./cost/index.js`, `./ideation/index.js`, `./platform/index.js` and
`./provenance/index.js`, none of which exist, so anything importing `src/index.ts` fails to
resolve. StayQuiet's frontend imports the concrete barrels instead.

```typescript
// Public TypeScript barrel for the parts of this repository the browser bundle uses.
// Only browser-safe surfaces are re-exported. The envelope arrives as a TYPE ONLY,
// from the generated module rather than the transport barrel: that barrel's runtime
// exports (publisher, subscriber, fallback, stream_router) statically import
// node:fs, node:crypto and node:http, and any runtime re-export drags all three
// into a browser bundle. Frontend code should still prefer the concrete path.
export type { DegradedResultRef, EventEnvelope } from "./platform/transport/event-envelope.js";
export * from "./platform/ui/index.js";
```

Why the transport barrel is type-only here: bundling an entry that imports it for the browser fails
with `Could not resolve "node:fs"` (twice), `"node:crypto"` and `"node:http"`. The generated
`event-envelope.ts` is pure type declarations and imports nothing, so a `export type { … }` from it
erases completely at compile time. `src/context/index.ts` and `src/resilience/index.ts` are
intentionally not re-exported either: `src/context` is loaded only by the Node-side context bridge,
and the resilience barrel resolves Node builtins lazily for Node callers.

**If `src/index.ts` was already written with the runtime `export * from
"./platform/transport/index.js"` line, replace those two lines with the block above.** It is a
two-line edit and nothing imports the file yet.

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| `config/stayquiet.json` missing or malformed | nothing — built-in `DEFAULTS` are used | one stderr line `[stayquiet] … using built-in defaults`; app runs normally |
| A single config key has the wrong type | that key falls back to its default | no visible change; the other keys still load |
| `pip install -r requirements.txt` fails on `strands-agents` | the whole entry is blocked (the SDK is the mandate) | the install error; WU-FOUND-02 exists precisely so this is discovered first, on day one, not at integration time |
| `contracts/tokenizer-profiles.json` still absent | token counts fall back to a chars/4 heuristic | a `[COST] unknown model_profile` warning; usage numbers become approximate but nothing crashes |
| AWS credentials absent | no live inference | `demo_mode` behaviour: golden-cache replies, degraded badge (implemented by DP-MODEL) |

## §7 Work units

### WU-FOUND-01 — Python and Node toolchains verified

**Goal.** Prove the machine can run this entry at all before writing any code.

**Steps.**
1. Run `python --version`. If it reports less than 3.11, stop and report — nothing else in this
   plan can proceed.
2. Run `node --version`. If it reports less than v20, stop and report.
3. Run `npm install` in the repository root (installs the already-declared devDependencies).

**Files created/modified.** `node_modules/` (not committed), `package-lock.json` or
`pnpm-lock.yaml` (leave whichever the tool writes).

**Verification command.**
```bash
python -c "import sys; assert sys.version_info >= (3,11), sys.version; print('py-ok')" && node -e "console.log('node-ok', process.versions.node.split('.')[0] >= '20')"
```
**Expected output.**
```
py-ok
node-ok true
```
**What it proves.** Both runtimes meet the versions the rest of the plans assume (SQ-N-08).

---

### WU-FOUND-02 — Dependencies declared and the Strands SDK import verified

**Goal.** Install the mandated SDK and prove `from strands import Agent, tool` works, on day one.

**Steps.**
1. Create `requirements.txt` with the literal contents of §5.3.
2. Replace `pyproject.toml` wholesale with the literal contents of §5.4.
3. Run `python -m pip install -r requirements.txt` — **`python -m pip`, not bare `pip`**. On a
   machine with several interpreters (a uv-managed 3.12 alongside a system 3.14, for example) bare
   `pip` can install into an interpreter that is not the one `python` resolves to, and every later
   verification command then fails with `ModuleNotFoundError` for a package that is installed.
   `python -m pip` always targets the interpreter the rest of this plan uses. If the environment is
   externally managed and refuses the install, add `--break-system-packages` or create a virtual
   environment first, and record which you did in the run report.
4. If `strands-agents` fails to install, stop and report the error verbatim — do not substitute
   another framework, do not vendor code, do not proceed. The SDK is the hackathon's only hard
   technology mandate.

**Files created/modified.** `requirements.txt`, `pyproject.toml`.

**Verification command.**
```bash
python -c "from strands import Agent, tool; from strands.models import BedrockModel; import fastapi, uvicorn, jsonschema, boto3; print('strands-ok')"
```
**Expected output.**
```
strands-ok
```
**What it proves.** The mandated Strands Agents SDK for Python, its Bedrock model provider, and
every other runtime dependency import successfully — so DP-MODEL and DP-AGENT can be written
against the real API.

---

### WU-FOUND-03 — Pre-existing module imports verified

**Goal.** Prove the resilience, cost and transport modules already in the repository import
cleanly from the repository root, since every later plan depends on that.

**Steps.**
1. Create `src/stayquiet/__init__.py` with the literal contents of §3.2.
2. Create `engine/__init__.py` with the literal contents of §3.3.
3. Create the directory `engine/tools/` and `engine/tools/__init__.py` with the literal contents
   of §3.4.
4. Create `contracts/tokenizer-profiles.json` with the literal contents of §5.5.
5. Run the verification command. If an import fails, report the traceback; do not edit any file
   under `src/resilience/`, `src/cost/` or `src/platform/`.

**Files created/modified.** `src/stayquiet/__init__.py`, `engine/__init__.py`,
`engine/tools/__init__.py`, `contracts/tokenizer-profiles.json`.

**Verification command.**
```bash
python -c "
from src.resilience import with_resilience, is_degraded_result, create_golden_cache
from src.cost import with_cost_guardrail, get_default_store
from src.platform.transport.event_envelope import EventEnvelope
import engine.tools, src.stayquiet
print('modules-ok', len(engine.tools.ALL_TOOLS))
"
```
**Expected output.**
```
modules-ok 0
```
**What it proves.** The exact import lines every later plan copies (blueprint §2.4b rows C1, C3,
C5) resolve from the repository root, and the two new packages are importable.

---

### WU-FOUND-04 — Configuration surface, licence and env example

**Goal.** One configuration reader, the MIT licence file, and a checked-in env template.

**Steps.**
1. Create `config/stayquiet.json` with the literal contents of §5.2.
2. Create `src/stayquiet/config.py` with the literal contents of §5.1.
3. Create `LICENSE` with the literal contents of §5.6.
4. Create `.env.example` with the literal contents of §5.7.
5. Replace `README.md` with exactly these two lines (DP-SUBMIT writes the real README later; this
   removes the assembled placeholder that names shared infrastructure, which the entry's README
   policy forbids):
   ```markdown
   # StayQuiet

   A background agent for independent short-stay hosts, built with the Strands Agents SDK for Python on Amazon Bedrock. Full README follows.
   ```
6. Confirm `.env` is not present in `git status`.

**Files created/modified.** `config/stayquiet.json`, `src/stayquiet/config.py`, `LICENSE`,
`.env.example`, `README.md`.

**Verification command.**
```bash
python -c "
from src.stayquiet.config import load_app_config
c = load_app_config()
print(c['model_id'], c['region'], c['demo_mode'], c['max_bookings'], c['escalate_refund_over_eur'])
" && head -1 LICENSE
```
**Expected output.**
```
global.anthropic.claude-sonnet-4-6 us-west-2 False 6 0.0
MIT License
```
**What it proves.** `load_app_config()` (contract row 2) returns the complete `AppConfig` every
later plan imports, and the MIT licence file the submission rules demand is present.

---

### WU-FOUND-05 — TypeScript barrel repaired

**Goal.** Make the TypeScript side type-check, so DP-UI can build.

**Steps.**
1. Replace `src/index.ts` wholesale with the literal contents of §5.8.
2. Run the verification command.
3. If `tsc` reports errors in files owned by pre-existing modules (`src/data/**`,
   `src/ideation/**`, `src/provenance/**`), record them in the run report and continue — those
   directories are not part of the browser bundle and DP-UI's build does not compile them. Only
   errors in `src/index.ts`, `src/platform/**` or `src/context/**` are blocking here.

**Files created/modified.** `src/index.ts`.

**Verification command.** TypeScript 7 refuses to load `tsconfig.json` when files are named on
the command line (`error TS5112`), which makes a per-file invocation report that one error and
nothing about the file itself. Run the compiler in project mode and filter to the blocking scope:

```bash
npx tsc --noEmit 2>&1 | grep -E "^(src/index\.ts|src/platform/|src/context/)" | wc -l; npx tsc --noEmit 2>&1 | grep -E "error TS" | sed "s/(.*//" | sort -u
```
**Expected output.**
```
0
src/ideation/demodrive/feeder.ts
```
**What it proves.** No error is reported in `src/index.ts` or in the two directories the browser
bundle compiles (`src/platform/`, `src/context/`), and the only file that does report one is
`src/ideation/demodrive/feeder.ts` — a pre-existing reference to the `dev-tooling` module, which
`design_documents/proposal.json` excludes. That is the non-blocking case step 3 describes; record it
and continue.

The second command exists so the first cannot pass vacuously: it lists every file with an error, so
a new failure anywhere is visible even when it is outside the filtered scope. To confirm the filter
really bites, append `export * from "./nope.js";` to `src/index.ts`, re-run, see `1`, then remove
it.

---

## §8 Verification summary

```bash
# WU-FOUND-01
python -c "import sys; assert sys.version_info >= (3,11), sys.version; print('py-ok')" && node -e "console.log('node-ok', process.versions.node.split('.')[0] >= '20')"
# WU-FOUND-02
python -c "from strands import Agent, tool; from strands.models import BedrockModel; import fastapi, uvicorn, jsonschema, boto3; print('strands-ok')"
# WU-FOUND-03
python -c "from src.resilience import with_resilience, is_degraded_result, create_golden_cache; from src.cost import with_cost_guardrail, get_default_store; from src.platform.transport.event_envelope import EventEnvelope; import engine.tools, src.stayquiet; print('modules-ok', len(engine.tools.ALL_TOOLS))"
# WU-FOUND-04
python -c "from src.stayquiet.config import load_app_config; c=load_app_config(); print(c['model_id'], c['region'], c['demo_mode'], c['max_bookings'], c['escalate_refund_over_eur'])" && head -1 LICENSE
# WU-FOUND-05
npx tsc --noEmit src/index.ts --module nodenext --moduleResolution nodenext --target es2022 --jsx react-jsx --skipLibCheck 2>&1 | grep -c "src/index.ts" || echo 0
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| `strands-agents` version resolves to an API different from the one DP-MODEL/DP-AGENT assume | WU-02 runs the import as the very first code-touching step; the pin `>=1.0,<2.0` prevents a major-version drift; every Strands touchpoint is confined to two functions in `src/stayquiet/model.py` |
| Someone "fixes" `pyproject.toml` by restoring the console-script entries | §5.4 is a wholesale replacement and §2 OUT lists nothing else — the entries reference packages that are not in this repository and would break `pip install .` |
| `os.environ.setdefault("GOLDEN_CACHE_DIR", …)` surprises a caller who wanted the default cache dir | it is a `setdefault`, so an explicit env value always wins; the behaviour is documented in §5.1's docstring and in §5.2's key table |
| An implementor edits a pre-existing module to make an import work | §2 OUT marks all six pre-existing module directories read-only; WU-03 explicitly forbids it |
