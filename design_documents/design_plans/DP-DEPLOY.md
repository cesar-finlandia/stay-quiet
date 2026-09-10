# DP-DEPLOY — Container, AWS App Runner public URL, golden cache, offline capture, optional AgentCore

## §0 Context & blockers

Must already exist:

* **DP-API**: `src/stayquiet/api.py`, `src/stayquiet/__main__.py`; DP-API WU-03 passing.
* **DP-UI**: `npm run build:ui` producing `dist/index.html` and `dist/assets/*`; DP-UI WU-03
  passing.
* **DP-MODEL**: `src/stayquiet/model.py` with `record_golden`, `golden_keys`;
  `engine/bridge/context_fit.ts`.
* **DP-AGENT**: `engine/agents/__init__.py` exporting `run_cycle`.

Operator prerequisites for the AWS work units (WU-04 only): the `aws` CLI v2 authenticated
(`aws sts get-caller-identity` succeeds), Docker running, and `AWS_ACCOUNT_ID`, `AWS_REGION`,
`ECR_REPOSITORY` set. WU-01, WU-02, WU-03, WU-05 and WU-06 need none of that.

**Working directory for every command in this plan is the entry repository root.**

## §1 Purpose & requirement IDs

Make the thing reachable and un-breakable on demo day: one container, one public HTTPS URL, a
committed golden cache so it runs with no credentials, a recorded capture so it runs with no
network, and an optional AgentCore-ready entrypoint.

Requirements (blueprint §1): **SQ-F-13** (public HTTPS URL, no login, testable with nobody
present), **SQ-N-01** (the golden cache is what makes the resilience fallback real rather than
theoretical), **SQ-N-02** (≤5 s offline), **SQ-N-06** (no secret in the image or the repo).

## §2 Scope boundaries

### IN — the only files this plan creates or modifies

1. `Dockerfile`
2. `.dockerignore`
3. `scripts/record_golden.py`
4. `scripts/deploy-apprunner.sh`
5. `scripts/smoke.sh`
6. `deploy/agentcore/main.py` (optional work unit)
7. `deploy/agentcore/requirements.txt` (optional work unit)
8. `deploy/agentcore/README.md` (optional work unit)
9. `package.json` — add exactly one script key, `"build:bridge"`; change nothing else
10. `fixtures/demodrive/click-script.json`
11. `fixtures/golden/*.json` — the recorded cache entries (data, committed)

### OUT — owned elsewhere; never create or edit here

| File | Owner |
|---|---|
| `src/**`, `engine/**` | their own plans |
| `fixtures/synthetic/**` | DP-DATA |
| `README.md`, `docs/architecture.*`, `disclosure.md` | DP-SUBMIT |
| `config/deploy/**`, `src/platform/deploy/**` | pre-existing — read-only, and see the note below |
| `../../hackathons/hackathon-projects/2026-09-agents_for_humans/demo-video-script.md` | DP-SCRIPT |

Note on the pre-existing deploy layer: `src/platform/deploy/` dispatches `npm run deploy` on
`DEPLOY_PROVIDER`, and its `docker` adapter builds and pushes to `DOCKER_REGISTRY` then reads
`PUBLIC_URL`. StayQuiet uses `scripts/deploy-apprunner.sh` instead, because the adapter stops at
`docker push` and cannot create the App Runner service that produces the URL. **Do not add a new
descriptor to `config/deploy/`** — the dispatcher cross-checks descriptors against adapters and
fails loudly on a descriptor without one.

## §3 Interfaces owned

This plan owns no importable Python or TypeScript surface. Its contracts are four commands and one
optional file:

| Command | Contract |
|---|---|
| `npm run build:bridge` | writes `dist/bridge/context_fit.mjs`, a dependency-free ES module the container's bare `node` can run |
| `python scripts/record_golden.py` | runs live cycles and writes `fixtures/golden/*.json` so `STAYQUIET_DEMO_MODE=1` produces real text |
| `bash scripts/deploy-apprunner.sh` | builds the image, pushes it to Amazon ECR, creates or updates the AWS App Runner service, prints the public HTTPS URL as its last line |
| `bash scripts/smoke.sh <url>` | exits 0 only when that URL serves the app, `/healthz`, and a non-empty `/api/state` |
| `deploy/agentcore/main.py` | an Amazon Bedrock AgentCore Runtime entrypoint wrapping the same Strands agent (optional) |

## §4 Interfaces consumed

```python
from engine.agents import run_cycle                                  # DP-AGENT
from src.stayquiet.model import build_agent, record_golden, result_text, golden_keys  # DP-MODEL
from src.stayquiet.config import load_app_config                     # DP-FOUND
from engine.tools import ALL_TOOLS                                   # DP-TOOLS
```

Shell scripts consume `python -m src.stayquiet` (DP-API) and `npm run build:ui` (DP-UI).

## §5 Literal file contents

### §5.1 `Dockerfile` — complete file

```dockerfile
# StayQuiet — one image, one port, one process.
#
# Stage 1 builds the browser bundle and the standalone context-buffer bridge with
# the repository's Node toolchain. Stage 2 is a Python runtime that also carries a
# bare `node` binary (copied from the official Node image, no node_modules) so the
# bridge runs without shipping 200 MB of packages.
FROM node:20-slim AS web
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY contracts ./contracts
COPY src ./src
COPY engine ./engine
RUN npm run build:ui && npm run build:bridge

FROM python:3.11-slim AS runtime
# A bare Node binary for the context-buffer bridge. No npm, no node_modules.
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    HOST=0.0.0.0
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY config ./config
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY src ./src
COPY engine ./engine
COPY pyproject.toml ./
COPY --from=web /build/dist ./dist
EXPOSE 8080
# No secret is baked in: with no AWS credentials the app serves the recorded cache.
CMD ["python", "-m", "src.stayquiet"]
```

### §5.2 `.dockerignore` — complete file

```
.git
.gitignore
node_modules
dist
.cache
.venv
__pycache__
**/__pycache__
*.pyc
.env
.env.*
design_documents
docs
examples
tests
run_sweep.sh
fixtures/audit
```

`fixtures/synthetic` and `fixtures/golden` are deliberately NOT ignored — they are the data the
product runs on. `fixtures/audit` is a runtime artifact and is excluded.

### §5.3 `package.json` — the one added script

Add exactly this key to the existing `"scripts"` object and change nothing else:

```json
"build:bridge": "npx esbuild engine/bridge/context_fit.ts --bundle --platform=node --format=esm --outfile=dist/bridge/context_fit.mjs --alias:src=./src"
```

`esbuild` ships with Vite, so no new dependency is added. The `--alias:src=./src` flag resolves the
bridge's `import { fit } from "src/context/index.js"` the same way `tsconfig.json` and
`vite.config.ts` do.

If the installed esbuild rejects `--alias:`, use this equivalent instead and record the change in
the run report:

```json
"build:bridge": "npx vite build --config vite.bridge.config.ts"
```

…which requires creating `vite.bridge.config.ts` with `build: { lib: { entry:
'engine/bridge/context_fit.ts', formats: ['es'], fileName: () => 'context_fit.mjs' }, outDir:
'dist/bridge', emptyOutDir: false, ssr: true }` and the same `src` alias as `vite.config.ts`. Prefer
the esbuild one-liner.

### §5.4 `scripts/record_golden.py` — complete file

```python
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
```

Note the checklist round-trip: `record_golden` stores the list as `- ` lines, which is exactly the
format `parse_checklist()` reads, so the offline path reproduces the same items.

### §5.5 `scripts/deploy-apprunner.sh` — complete file

```bash
#!/usr/bin/env bash
# StayQuiet — build, push to Amazon ECR, and run on AWS App Runner.
# Prints the public HTTPS URL as its LAST line. Idempotent: re-running updates the
# existing service instead of creating a second one.
#
#   AWS_ACCOUNT_ID=123456789012 AWS_REGION=us-west-2 bash scripts/deploy-apprunner.sh
#
# Requires: aws CLI v2 authenticated, Docker running.
set -euo pipefail

: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID (see .env.example)}"
: "${AWS_REGION:=us-west-2}"
: "${ECR_REPOSITORY:=stayquiet}"
SERVICE_NAME="${SERVICE_NAME:-stayquiet}"
ROLE_NAME="${ROLE_NAME:-StayQuietAppRunnerECRAccess}"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

echo "[deploy] region=${AWS_REGION} repo=${ECR_REPOSITORY} service=${SERVICE_NAME}"

# 1. ECR repository ---------------------------------------------------------
aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" --region "$AWS_REGION" \
  >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPOSITORY" --region "$AWS_REGION" >/dev/null
echo "[deploy] ECR repository ready"

# 2. Build and push ---------------------------------------------------------
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
docker build -t "${ECR_URI}:latest" .
docker push "${ECR_URI}:latest"
echo "[deploy] image pushed: ${ECR_URI}:latest"

# 3. Access role App Runner uses to pull from a private ECR ------------------
ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess >/dev/null
  echo "[deploy] created access role ${ROLE_NAME}; waiting 15s for IAM propagation"
  sleep 15
fi

# 4. Create or update the service -------------------------------------------
SERVICE_ARN="$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn | [0]" --output text)"

SOURCE_CFG=$(cat <<JSON
{"ImageRepository":{"ImageIdentifier":"${ECR_URI}:latest","ImageRepositoryType":"ECR",
 "ImageConfiguration":{"Port":"8080","RuntimeEnvironmentVariables":{"STAYQUIET_CYCLE_INTERVAL_S":"300"}}},
 "AutoDeploymentsEnabled":false,
 "AuthenticationConfiguration":{"AccessRoleArn":"${ROLE_ARN}"}}
JSON
)

if [ "$SERVICE_ARN" = "None" ] || [ -z "$SERVICE_ARN" ]; then
  SERVICE_ARN="$(aws apprunner create-service --region "$AWS_REGION" \
    --service-name "$SERVICE_NAME" \
    --source-configuration "$SOURCE_CFG" \
    --instance-configuration '{"Cpu":"1 vCPU","Memory":"2 GB"}' \
    --health-check-configuration '{"Protocol":"HTTP","Path":"/healthz","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}' \
    --query 'Service.ServiceArn' --output text)"
  echo "[deploy] service created"
else
  aws apprunner update-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
    --source-configuration "$SOURCE_CFG" >/dev/null
  echo "[deploy] service updated"
fi

# 5. Wait for RUNNING -------------------------------------------------------
for _ in $(seq 1 60); do
  STATUS="$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
    --query 'Service.Status' --output text)"
  [ "$STATUS" = "RUNNING" ] && break
  case "$STATUS" in
    CREATE_FAILED|DELETE_FAILED|PAUSED)
      echo "[deploy] service status ${STATUS} — see the App Runner console event log." >&2
      echo "[deploy] Fallback ladder: (1) run locally with 'python -m src.stayquiet' and demo on localhost," >&2
      echo "[deploy]   (2) STAYQUIET_DEMO_MODE=1 for the offline recorded run, (3) use the recorded capture." >&2
      exit 1 ;;
  esac
  echo "[deploy] status=${STATUS}; waiting"
  sleep 15
done

URL="https://$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
  --query 'Service.ServiceUrl' --output text)"
echo "[deploy] live at:"
echo "$URL"
```

Cost note for the operator: App Runner bills per provisioned instance-hour. At `1 vCPU / 2 GB` it
is a few US dollars for the judging period, well inside the $50 AWS promotional credit. Pause or
delete the service after the judging period ends (`aws apprunner delete-service --service-arn …`),
**not before** — the rules require the project to stay testable until judging closes.

### §5.6 `scripts/smoke.sh` — complete file

```bash
#!/usr/bin/env bash
# StayQuiet — verify a deployed URL really serves the product.
#   bash scripts/smoke.sh https://xxxx.us-west-2.awsapprunner.com
set -euo pipefail
URL="${1:-${PUBLIC_URL:-}}"
: "${URL:?usage: bash scripts/smoke.sh <https://host>}"
URL="${URL%/}"

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

curl -fsS "${URL}/healthz" | grep -q '"ok":true' || fail "/healthz did not report ok"
curl -fsS "${URL}/" | grep -qi 'stayquiet' || fail "/ did not serve the app"
STATE="$(curl -fsS "${URL}/api/state")"
echo "$STATE" | grep -q '"track": *"Professional Agents"' || fail "/api/state missing the track"
echo "$STATE" | grep -q '"synthetic": *true' || fail "/api/state missing the synthetic marker"
curl -fsS "${URL}/events" | grep -q '"status": *"complete"' || fail "/events snapshot malformed"
echo "SMOKE OK: ${URL}"
```

### §5.7 `deploy/agentcore/main.py` — complete file (optional work unit)

```python
# StayQuiet — optional Amazon Bedrock AgentCore Runtime entrypoint.
#
# The submitted product is the container in the repository root; this file exists so
# the SAME Strands agent, with the SAME six tools, can also be hosted on AgentCore
# Runtime, which the hackathon rules call out as strengthening Technical
# Implementation. It adds nothing to the product and is not required to run it.
#
# Local check:   python deploy/agentcore/main.py        # serves on :8080
# Deploy:        see deploy/agentcore/README.md
#
# It reuses build_agent() (DP-MODEL) and ALL_TOOLS (DP-TOOLS) — there is no second
# agent definition anywhere in this repository.
from __future__ import annotations

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from engine.agents.stayquiet_agent import load_prompt, run_cycle
from engine.tools import ALL_TOOLS
from src.stayquiet.model import build_agent, result_text

app = BedrockAgentCoreApp()
_agent = build_agent(tools=ALL_TOOLS, system_prompt=load_prompt("system.stayquiet.md"))


@app.entrypoint
def invoke(payload: dict) -> dict:
    """Two modes, chosen by the payload.

    {"action": "cycle"}            → run one full background cycle and return its summary
    {"prompt": "<text>"}           → one turn of the same agent, with the same tools
    """
    if str(payload.get("action", "")).lower() == "cycle":
        result = run_cycle()
        return {
            "summary": result["summary"],
            "bookings_affected": result["bookings_affected"],
            "decisions": [
                {"booking_id": d["booking_id"], "kind": d["kind"], "summary": d["summary"]}
                for d in result["decisions"]
            ],
            "quiet_actions": result["quiet_actions"],
            "degraded": result["degraded"],
        }
    prompt = str(payload.get("prompt") or "Summarise what changed in the policy and who it affects.")
    return {"result": result_text(_agent(prompt))}


if __name__ == "__main__":
    app.run()
```

### §5.8 `deploy/agentcore/requirements.txt` — complete file

```
strands-agents>=1.0,<2.0
bedrock-agentcore
boto3>=1.35
jsonschema>=4.21
typing_extensions>=4.13
```

### §5.9 `deploy/agentcore/README.md` — complete file

```markdown
# Optional: running StayQuiet's agent on Amazon Bedrock AgentCore Runtime

The submitted product is the container in the repository root (`Dockerfile`,
`python -m src.stayquiet`). This directory is an additional, optional host for the *same*
Strands agent and the *same* six tools — nothing here is a second implementation.

## Local check

```bash
pip install -r deploy/agentcore/requirements.txt
python deploy/agentcore/main.py
# in another terminal:
curl -s -X POST localhost:8080/invocations -H 'content-type: application/json' \
  -d '{"action":"cycle"}'
```

## Deploying

AWS ships two toolchains for AgentCore Runtime, and which one applies depends on the version
installed:

* **AgentCore CLI (npm, current):** `npm install -g @aws/agentcore`, then `agentcore create` in a
  scratch directory choosing framework **Strands Agents**, copy this `main.py` over the generated
  entrypoint together with `src/` and `engine/`, then `agentcore deploy` and
  `agentcore invoke --prompt "…"`. Check status with `agentcore status`.
* **Starter toolkit (pip, earlier):** `pip install bedrock-agentcore-starter-toolkit`, then
  `agentcore configure --entrypoint deploy/agentcore/main.py`, `agentcore launch`,
  `agentcore invoke '{"action":"cycle"}'`.

Both need AWS credentials and Bedrock model access. If neither is available, skip this directory:
the product's own container is the submitted deployment.
```

## §6 Failure modes

| Failure | What degrades | What the user sees |
|---|---|---|
| `npm run build:bridge` fails | the container's context buffer | `fit_thread` degrades to the deterministic trim and says so on the `booking_lookup` envelope; everything else is unaffected |
| No live Bedrock access when recording | the golden cache stays empty | `record_golden.py` exits 1 with a clear message; the offline demo then falls back to `FALLBACK_DRAFT`, which is honest but weaker — record the cache before the video |
| ECR or App Runner fails | the optional live-demo link only | the script prints the fallback ladder and exits 1; every other submission artifact is unaffected |
| App Runner cold start on a judge's first visit | first load latency | `/healthz` answers as soon as the process binds, and the scheduler runs its first cycle two seconds later, so a judge sees work almost immediately |
| Docker not installed on the operator's machine | the container path | run `python -m src.stayquiet` locally instead; the video can be recorded from localhost, and the live link is an optional field |
| AgentCore toolchain differs from both documented paths | the optional entrypoint | skip WU-05 entirely; it is marked optional and nothing depends on it |

## §7 Work units

### WU-DEPLOY-01 — The standalone context bridge

**Goal.** A dependency-free bridge bundle so the runtime image needs only a `node` binary.

**Steps.**
1. Add the `"build:bridge"` script of §5.3 to `package.json`. Change nothing else in that file.
2. Run `npm run build:bridge`.
3. Confirm `dist/bridge/context_fit.mjs` exists and contains no `import` of a bare package name
   (it must be fully bundled).

**Files created/modified.** `package.json`, `dist/bridge/context_fit.mjs` (build output, not
committed).

**Verification command.**
```bash
npm run build:bridge > /dev/null 2>&1 && echo '{"messages":[{"role":"user","content":"word word word"}],"maxTokens":900}' | node dist/bridge/context_fit.mjs
```
**Expected output.**
```
{"messages":[{"role":"user","content":"word word word"}],"dropped":0,"tokens":9}
```
**What it proves.** The pre-existing context buffer runs from a single bundled file under a bare
`node`, which is exactly what the container provides. (`dropped` must be `0` and the message
must come back unchanged; those are the binding assertions.)

Amendment 2026-09-10: the expected `tokens` used to read `3` with a note allowing a
difference of "one or two". The bedrock profile's counter is `ceil(chars/4) + 5` framing
tokens per message (`src/context/token_counter.ts`, DP-E §4.5 calibration): 14 chars →
`ceil(14/4) = 4`, plus 5 framing = **9**. The old `3` was bare chars/4 without the
documented framing, so no implementation could ever print it through this bridge. The
framing is identical in the dev (`vite-node`) and bundled paths — it is the same code —
so budgets behave the same in both.

---

### WU-DEPLOY-02 — The image

**Goal.** One container that serves the whole product on port 8080 with no secrets.

**Steps.**
1. Create `.dockerignore` with §5.2 verbatim, then `Dockerfile` with §5.1 verbatim.
2. `docker build -t stayquiet:local .`
3. `docker run --rm -p 8080:8080 -e STAYQUIET_DEMO_MODE=1 -e STAYQUIET_CYCLE_INTERVAL_S=30 stayquiet:local`
4. In a second terminal run the verification command, then stop the container.

**Files created.** `Dockerfile`, `.dockerignore`.

**Verification command.**
```bash
for i in $(seq 1 24); do curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break || sleep 5; done && bash scripts/smoke.sh http://127.0.0.1:8080 && docker run --rm --entrypoint sh stayquiet:local -c "node --version && ls dist/bridge && test ! -f .env && echo no-secrets"
```

Amendment 2026-09-10: the command used to start with a fixed `sleep 6`. A cold
container needs ~2 s for interpreter imports, 2 s for the scheduler's first tick and
~2.3 s for the cycle itself before `/api/state` is non-empty — measured 7 s minimum,
so 6 s fails on any unhurried machine. The bounded readiness poll (24 × 5 s) waits
for the same healthy state instead of guessing a duration; everything it asserts is
unchanged.
**Expected output.**
```
SMOKE OK: http://127.0.0.1:8080
v20.<something>
context_fit.mjs
no-secrets
```
**What it proves.** The image serves the built app, the API and the event snapshot on one port,
carries the Node binary and the bundled bridge the context buffer needs, and contains no `.env`.

> `scripts/smoke.sh` must exist before this command runs — create it from §5.6 as part of this
> work unit's step 1 if WU-04 has not run yet.

---

### WU-DEPLOY-03 — Record the golden cache

**Goal.** Make the offline rung real: recorded Amazon Bedrock answers, committed.

**Steps.**
1. Create `scripts/record_golden.py` with §5.4 verbatim.
2. With AWS credentials and Bedrock model access available and `STAYQUIET_DEMO_MODE` unset, run
   `python scripts/record_golden.py`.
3. Commit `fixtures/golden/`. These are model outputs about synthetic bookings — no personal data.
4. Re-run the offline cycle and confirm the drafts now come from the cache rather than the
   fallback text.

**Files created.** `scripts/record_golden.py`, `fixtures/golden/*.json`.

**Verification command.**
```bash
python scripts/record_golden.py --check | head -3 && STAYQUIET_DEMO_MODE=1 python -c "
import time
from engine.agents import run_cycle
t0 = time.time(); r = run_cycle()
print('sources', sorted({d['source'] for d in r['drafts']}))
print('all-cached', all(d['source'] == 'cache' for d in r['drafts'] + r['checklists']))
print('offline_seconds', round(time.time() - t0, 1) <= 5.0)
print('counts', r['bookings_affected'], len(r['decisions']), r['quiet_actions'])
"
```
**Expected output.**
```
golden cache: 8 entries
  checklist::BK-1042::2026-09-08
  checklist::BK-1043::2026-09-08
sources ['cache']
all-cached True
offline_seconds True
counts 4 3 1
```
**What it proves.** Eight recorded entries (two per affected booking) make the whole product run
offline from real model output in under five seconds, with the deterministic counts unchanged —
rung 3 of the fallback ladder and the SQ-N-02 offline budget.

> If step 2 could not run for lack of Bedrock access, this work unit fails and must be reported as
> failed. Do NOT hand-write cache entries to make the check pass: the whole point of the cache is
> that it holds real measured output, and DP-SCRIPT's fact ledger cites it.

---

### WU-DEPLOY-04 — Public HTTPS URL on AWS

**Goal.** The optional-but-scoring live demo link.

**Steps.**
1. Create `scripts/deploy-apprunner.sh` with §5.5 verbatim and `scripts/smoke.sh` with §5.6.
2. `chmod +x scripts/deploy-apprunner.sh scripts/smoke.sh` (no-op on Windows).
3. Export `AWS_ACCOUNT_ID`, `AWS_REGION`, `ECR_REPOSITORY`, then run
   `bash scripts/deploy-apprunner.sh`. Save its last line as `PUBLIC_URL`.
4. Run the verification command.
5. If any AWS step fails: record the exact error, do NOT weaken the script, and continue with the
   rest of the plans. The live link is an optional submission field; the video and the repository
   are not.

**Files created.** `scripts/deploy-apprunner.sh`, `scripts/smoke.sh`.

**Verification command.**
```bash
bash scripts/smoke.sh "$PUBLIC_URL" && curl -fsS "$PUBLIC_URL/api/state" | python -c "
import json, sys
s = json.load(sys.stdin)
print('track', s['config']['track'])
print('stack', s['config']['stack'])
print('run', bool(s['run']), 'decisions', len(s['decisions']))
"
```
**Expected output.**
```
SMOKE OK: https://…awsapprunner.com
track Professional Agents
stack Strands Agents SDK for Python on Amazon Bedrock
run True decisions 3
```
**What it proves.** A judge with only the URL, no credentials and no operator present sees a
completed background cycle with three decisions waiting — the whole of SQ-F-13.

---

### WU-DEPLOY-05 — AgentCore entrypoint (OPTIONAL — skip if time is short)

**Goal.** Host the same Strands agent on Amazon Bedrock AgentCore Runtime, which the rules name as
strengthening Technical Implementation.

**This work unit is optional.** Nothing else depends on it. If `bedrock-agentcore` will not
install, or the AgentCore toolchain does not match either path documented in §5.9, delete the
`deploy/agentcore/` directory and move on — do not spend the remaining time here, and do not claim
an AgentCore deployment anywhere if it did not happen.

**Steps.**
1. Create `deploy/agentcore/main.py` (§5.7), `requirements.txt` (§5.8) and `README.md` (§5.9).
2. `pip install -r deploy/agentcore/requirements.txt`.
3. Run the verification command.
4. Cloud deployment itself is an operator step, documented in §5.9 — not a work unit, because it
   cannot be verified deterministically from this machine.

**Files created.** the three files in `deploy/agentcore/`.

**Verification command.**
```bash
STAYQUIET_DEMO_MODE=1 python -c "
import importlib.util
if importlib.util.find_spec('bedrock_agentcore') is None:
    print('SKIPPED: bedrock-agentcore not installed'); raise SystemExit(0)
import deploy.agentcore.main as m
print('entrypoint', callable(m.invoke))
print('cycle', m.invoke({'action': 'cycle'})['bookings_affected'])
"
```
**Expected output.** either
```
entrypoint True
cycle 4
```
or
```
SKIPPED: bedrock-agentcore not installed
```
**What it proves.** The AgentCore entrypoint wraps the *same* agent and the *same* cycle — the
identical four affected bookings — rather than a second implementation, or it is honestly skipped.

---

### WU-DEPLOY-06 — Recorded golden-path capture

**Goal.** Video footage that exists even if AWS, the network or the model is unavailable on the
day. Rung 4 of the ladder.

**Steps.**
1. Terminal 1: `STAYQUIET_DEMO_MODE=1 STAYQUIET_CYCLE_INTERVAL_S=30 python -m src.stayquiet`
2. Capture the golden path with the pre-existing capture tool, writing **outside** the entry
   repository as the entry's contents policy requires:
   ```bash
   npx playwright install chromium
   DEMODRIVE_BASE_URL=http://127.0.0.1:8080 npm run demodrive -- capture \
     --script fixtures/demodrive/click-script.json \
     --data-source cache \
     --out ../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture
   ```
3. Create `fixtures/demodrive/click-script.json` first, with these steps in order: load `/`,
   wait for the progress list, screenshot; wait for the decision cards, screenshot; click
   `Approve and file` on the first card, screenshot; scroll to the audit trail, screenshot.
   Shape it to the `DemodriveScript` types in `src/ideation/demodrive/script.ts`.
4. If the demodrive driver cannot run in this assembly (it imports the unassembled
   `src/dev/mock/runner.js`, and `contracts/demodrive-script.schema.json` was not
   assembled, so even script loading fails), capture the same four beats with plain
   Playwright instead — `capture.mjs` next to the PNGs shows how — or take four manual
   screenshots and a screen recording of the same four beats into the same folder, and
   record in the run report which path was used. The artifact matters; the tool does not.

**Files created.** `fixtures/demodrive/click-script.json`, plus capture artifacts **outside** the
entry repository.

**Amendment 2026-09-10:** the demodrive path of step 2 was attempted and fails before any
browser opens: `npm run demodrive -- --help` dies in `feeder.ts` on the missing
`../../dev/mock/runner.js` (the same pre-existing gap the repo's own `tsc` reports), and
one level deeper `loadDemodriveScript` would `readFileSync` the absent
`contracts/demodrive-script.schema.json`. Both files are chassis-owned and out of scope,
so the capture was done with a 40-line Playwright script performing the identical four
beats (progress → decisions → approve → audit) against the served app. The four PNGs and
the script live in the timestamped capture folder; `click-script.json` remains the
documented capture plan for an assembly where the driver works.

**Verification command.**
```bash
ls -1 ../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture | head -5 && find ../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture -name "*.png" | wc -l
```
**Expected output.** a listing of the capture run folder, then a count of `4` or more.
```
20260913-<hhmmss>
4
```
**What it proves.** There are at least four usable frames of the working product stored outside the
submitted repository, so the video can be cut even with no live system — and the entry repo still
contains only the application.

---

## §8 Verification summary

```bash
# WU-DEPLOY-01
npm run build:bridge > /dev/null 2>&1 && echo '{"messages":[{"role":"user","content":"word word word"}],"maxTokens":900}' | node dist/bridge/context_fit.mjs
# WU-DEPLOY-02  (container running in another terminal)
for i in $(seq 1 24); do curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break || sleep 5; done && bash scripts/smoke.sh http://127.0.0.1:8080 && docker run --rm --entrypoint sh stayquiet:local -c "node --version && ls dist/bridge && test ! -f .env && echo no-secrets"
# WU-DEPLOY-03
python scripts/record_golden.py --check | head -3 && STAYQUIET_DEMO_MODE=1 python -c "
import time
from engine.agents import run_cycle
t0=time.time(); r=run_cycle()
print('sources', sorted({d['source'] for d in r['drafts']}))
print('all-cached', all(d['source']=='cache' for d in r['drafts']+r['checklists']))
print('offline_seconds', round(time.time()-t0,1)<=5.0)
print('counts', r['bookings_affected'], len(r['decisions']), r['quiet_actions'])"
# WU-DEPLOY-04
bash scripts/smoke.sh "$PUBLIC_URL" && curl -fsS "$PUBLIC_URL/api/state" | python -c "
import json,sys; s=json.load(sys.stdin)
print('track', s['config']['track']); print('stack', s['config']['stack'])
print('run', bool(s['run']), 'decisions', len(s['decisions']))"
# WU-DEPLOY-05 (optional)
STAYQUIET_DEMO_MODE=1 python -c "
import importlib.util
if importlib.util.find_spec('bedrock_agentcore') is None:
    print('SKIPPED: bedrock-agentcore not installed'); raise SystemExit(0)
import deploy.agentcore.main as m
print('entrypoint', callable(m.invoke))
print('cycle', m.invoke({'action':'cycle'})['bookings_affected'])"
# WU-DEPLOY-06
ls -1 ../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture | head -5 && find ../../hackathons/hackathon-projects/2026-09-agents_for_humans/capture -name "*.png" | wc -l
```

## §9 Risks

| Risk | Mitigation |
|---|---|
| The image ships a secret | `.dockerignore` excludes `.env*`; WU-02's check asserts `.env` is absent inside the image; the app needs no secret to run |
| App Runner cannot pull from a private ECR | the script creates the access role and waits for IAM propagation; a failure prints the ladder and exits non-zero without leaving a half-built service |
| Recorded cache entries drift from the fixtures | keys embed `latest_captured_at`, so changing a snapshot invalidates them visibly (drafts fall back and the UI badges it) rather than silently serving stale text |
| Someone hand-writes cache entries to pass WU-03 | WU-03 forbids it explicitly, and DP-SCRIPT's fact ledger cites the recorded text as a measured source |
| App Runner keeps billing after judging | the cost note tells the operator to delete the service **after** judging closes, and warns not to do it before |
| AgentCore work eats the remaining time | WU-05 is marked optional in three places and its failure path is "delete the directory and move on" |
| The video depends on a live system | WU-06 produces the recorded capture before the video is shot, and it lives outside the entry repository per the contents policy |
| A second deploy descriptor breaks `npm run deploy` | §2 forbids adding one and explains that the dispatcher fails loudly on a descriptor without an adapter |
