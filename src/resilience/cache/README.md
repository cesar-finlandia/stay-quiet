# Golden-Path Cache (RES-05)

> **Requirement IDs:** RES-05, RES-RES-02, RES-RES-03, GOV-MIN-04, XCUT-08

File-based JSON key-value store per `master_blueprint.md §6.7` and `design_documents/design_plans/DP-A-resilience-layer.md §5`. Dependency-free: no SQLite, no new runtime deps (`GOV-MIN-04`). Gives every demo an offline guarantee (`RES-RES-02`): with the cache populated, the full flow completes with zero network.

## On-disk layout

```
<root>/                        # default <cwd>/.cache/golden; override via GOLDEN_CACHE_DIR or createGoldenCache(dir)
├── golden-index.json          # manifest { version:"1.0.0", entries:{ "<key>": {created_at, provider, model, source:"mock|data|manual", size_bytes[, explicit_key]} } }
├── <hash>.json                # one file per key; value is the original response payload (any JSON)
└── replay/
    └── <hash>.json            # replay subspace (fallback-chain step 3), addressed as keys prefixed "replay::"
```

- Individual `<hash>.json` files are the **source of truth for reads**; `golden-index.json` exists for offline listing and is recoverable by scanning `*.json` if lost/corrupt.
- Writes are atomic (tmp file + rename), so a crash never leaves partial entries.
- Corrupt JSON on read → treated as a miss + structured warn + quarantined to `<name>.corrupt.json`.
- Every method is failure-contained (`RES-RES-03`): FS errors log `[resilience] warn:` and return miss/false — they never throw to the caller.
- `<root>` defaults to `<cwd>/.cache/golden`, which is gitignored; only checked-in fixtures under `examples/dummy-fixtures/resilience/golden/` are committed.

## Key derivation algorithm (`deriveKey`)

Canonical, deterministic, pure (no timestamp, no randomness):

```
key        = sha256( provider + "|" + model + "|" + input_hash )   # 64-char lowercase hex = filename
input_hash = sha256( stable_json_stringify( normalized_input ) )
stable_json_stringify = JSON.stringify with object keys sorted lexicographically, no whitespace
normalized_input      = prompt/request body with binary buffers replaced by {"__buffer_sha256__": "<sha256-of-buffer>"}
provider/model        = trimmed and lowercased
```

Changing any provider/model/input byte changes the key. Explicit-key mode (`deriveKey({ explicitKey })`) hashes the caller kebab-case string once for filename uniformity; pass `{ explicit_key }` in `put` meta so the readable form lands in `golden-index.json`.

## API

```typescript
import { createGoldenCache } from "src/resilience"; // public boundary (DP-A §9.4)

const cache = createGoldenCache();                  // or createGoldenCache(tmpDir)
const key  = cache.deriveKey({ provider: "acme", model: "widget-v1", prompt });
await cache.put(key, value, { provider, model, source: "manual" });
const hit  = await cache.get(key);                  // null = miss (never throws)
(await cache.has(key)) === true;
await cache.delete(key);                            // boolean
const all  = await cache.list();                    // from golden-index.json
await cache.clear();                                // NO-OP unless RES_ALLOW_CACHE_CLEAR=1
```

Python mirror: `from src.resilience.cache import create_golden_cache` — same semantics (`get/put/has/delete/list/clear/derive_key`). Replay-subspace keys are plain strings like `"replay::<hash>"` in both languages.

## How to record a golden path

Manual path (walkthrough, DP-A §5.4 / §11.3) using the helper script:

```bash
# 1. Capture the real response once (online), saving it to a temp file.
# 2. Record it into the cache:
node src/resilience/scripts/record-golden.ts \
  --provider acme --model widget-v1 \
  --input  examples/dummy-fixtures/resilience/sample-payload.explicit-key.json \
  --output response.json \
  [--key demo-step-acme-widget-overview] [--source manual]

# 3. Verify offline replay: get now returns the stored payload with no network.
```

Other producers use the identical write path: `MOCK-05` publishes via `put` after each synthetic envelope (`--record`), `DATA-05` batch-writes with `source:"data"`. Consumers (`DEMODRIVE-01`, wrapper fallback step 2 "cache") only ever call `createGoldenCache()` / `cache.get` — never file-path knowledge.
