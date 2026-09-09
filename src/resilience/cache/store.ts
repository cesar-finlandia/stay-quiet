// Requirement IDs: RES-05, RES-RES-02, RES-RES-03, GOV-MIN-04, XCUT-08
// Golden-path cache store (DP-A §5) — file-based JSON KV, dependency-free
// (master_blueprint.md §6.7: no SQLite, no new runtime dep).
// Layout: <root>/golden-index.json manifest + one JSON file per key;
// replay subspace under <root>/replay/ addressed as keys prefixed "replay::".
// Individual files are the source of truth for reads (index loss is recoverable
// by scanning *.json). Every public method is RES-RES-03 guarded internally:
// FS errors log + return miss/false, never throw to the caller.
// Domain-free (GOV-REU-02); node stdlib only (RES-REU-01).

// Node builtins are resolved lazily via process.getBuiltinModule (node-compat)
// instead of static imports: the resilience barrel is imported by UI code
// (isDegraded → src/resilience), and a static node:* import would crash
// browser bundles at module-evaluation time. Under Node the bindings are the
// real stdlib modules; outside Node they are null and every use site sits in
// an RES-RES-03-guarded method where null degrades to a logged miss.
type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");
type CryptoModule = typeof import("node:crypto");
const fsMod = nodeBuiltin<FsModule>("node:fs");
const pathMod = nodeBuiltin<PathModule>("node:path");
const cryptoMod = nodeBuiltin<CryptoModule>("node:crypto");
import { nodeBuiltin } from "../node-compat.js";

//#region Constants & types

export const INDEX_VERSION = "1.0.0" as const;
export const REPLAY_PREFIX = "replay::";

export type CacheSource = "mock" | "data" | "manual";

export interface IndexEntry {
  created_at: string; // ISO-8601
  provider: string | null;
  model: string | null;
  source: CacheSource | null;
  size_bytes: number;
  /** Present iff recorded via explicit-key mode (readable form kept per DP-A §5.2). */
  explicit_key?: string;
}

export interface PutMeta {
  provider?: string;
  model?: string;
  source?: CacheSource | string;
  /** Explicit caller-supplied kebab-case key — stored readably in golden-index.json. */
  explicit_key?: string;
}

export interface ListEntry {
  created_at: string;
  provider: string | null;
  model: string | null;
}

export interface GoldenCache {
  /** null = miss (never throws). */
  get(key: string): Promise<unknown | null>;
  /** Atomic write (tmp file + rename). Never throws. */
  put(key: string, value: unknown, meta?: PutMeta): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  list(): Promise<Record<string, ListEntry>>;
  /** Test-only; gated behind RES_ALLOW_CACHE_CLEAR=1 env (no-op otherwise). */
  clear(): Promise<void>;
  deriveKey(input: { provider: string; model: string; prompt: unknown } | { explicitKey: string }): string;
}

//#endregion

//#region Warn sink

type WarnFn = (message: string) => void;

let warnFn: WarnFn = (message) => console.warn(`[resilience] warn: ${message}`);

/** Test seam: override the warn sink. Returns the previous sink. */
export function setCacheWarnLogger(fn: WarnFn): WarnFn {
  const prev = warnFn;
  warnFn = fn;
  return prev;
}

//#endregion

//#region Key derivation (DP-A §5.2)

/** Placeholder shape for binary buffers so cache is content-addressable (DP-A §5.2). */
const BUFFER_TAG = "__buffer_sha256__";

function sha256Hex(data: string | Uint8Array): string {
  return cryptoMod!.createHash("sha256").update(data).digest("hex");
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BUFFER_TAG]: sha256Hex(value) };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeValue(v);
    }
    return out;
  }
  return value;
}

/** JSON.stringify with object keys sorted lexicographically, no whitespace (DP-A §5.2). */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortDeep(normalizeValue(value)));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical, deterministic key derivation (pure — no timestamp, no randomness):
 *   key = sha256( provider + "|" + model + "|" + input_hash )
 *   input_hash = sha256( stable_json_stringify( normalized_input ) )
 * Provider/model are trimmed + lowercased; result is 64-char lowercase hex.
 */
export function deriveKeyStandalone(input: { provider: string; model: string; prompt: unknown } | { explicitKey: string }): string {
  if ("explicitKey" in input) {
    // Explicit mode: hashed once for uniform filenames (DP-A §5.2).
    return sha256Hex(input.explicitKey);
  }
  const provider = input.provider.trim().toLowerCase();
  const model = input.model.trim().toLowerCase();
  const inputHash = sha256Hex(stableJsonStringify(normalizeValue(input.prompt)));
  return sha256Hex(`${provider}|${model}|${inputHash}`);
}

//#endregion

//#region Key/path resolution

const KEY_RE = /^[0-9a-f]{64}$/;

interface KeyLocation {
  dir: string;
  name: string;
}

function resolveKeyLocation(rootDir: string, key: string): KeyLocation | null {
  let name = key;
  let dir = rootDir;
  if (key.startsWith(REPLAY_PREFIX)) {
    name = key.slice(REPLAY_PREFIX.length);
    dir = pathMod!.join(rootDir, "replay");
  }
  if (!KEY_RE.test(name)) {
    warnFn(`golden cache key invalid (${key.slice(0, 80)}), expecting 64-char lowercase hex`);
    return null;
  }
  return { dir, name };
}

//#endregion

//#region Index helpers (golden-index.json — manifest for offline listing only)

interface IndexFile {
  version: string;
  entries: Record<string, IndexEntry>;
}

function emptyIndex(): IndexFile {
  return { version: INDEX_VERSION, entries: {} };
}

function readIndex(root: string): IndexFile | null {
  const path = pathMod!.join(root, "golden-index.json");
  try {
    if (!fsMod!.existsSync(path)) return null;
    const parsed = JSON.parse(fsMod!.readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = (parsed as Record<string, unknown>) ["entries"];
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return null;
    return { version: String((parsed as Record<string, unknown>) ["version"] ?? INDEX_VERSION), entries: entries as Record<string, IndexEntry> };
  } catch (err) {
    warnFn(`golden-index.json unreadable or corrupt (${err instanceof Error ? err.message : String(err)}); recovering by scanning *.json`);
    return null;
  }
}

/** Atomic index write; failures are logged, never thrown (files are the source of truth). */
function writeIndex(root: string, index: IndexFile): void {
  try {
    fsMod!.mkdirSync(root, { recursive: true });
    atomicWrite(pathMod!.join(root, "golden-index.json"), JSON.stringify(index, null, 2) + "\n");
  } catch (err) {
    warnFn(`golden-index.json write failed (${err instanceof Error ? err.message : String(err)}); entry files remain authoritative`);
  }
}

/** Rebuild a logical index from entry files when golden-index.json is lost/corrupt. */
function scanIndex(root: string): IndexFile {
  const index = emptyIndex();
  const dirs = [root, pathMod!.join(root, "replay")];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      if (!fsMod!.existsSync(dir)) continue;
      names = fsMod!.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.includes(".corrupt.") && n !== "golden-index.json");
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const key = name.slice(0, -".json".length);
        const prefix = dir === root ? "" : REPLAY_PREFIX;
        const stat = fsMod!.statSync(pathMod!.join(dir, name));
        index.entries[`${prefix}${key}`] = {
          created_at: new Date(stat.mtimeMs).toISOString(),
          provider: null,
          model: null,
          source: null,
          size_bytes: stat.size,
        };
      } catch {
        // unreadable file — skip silently-ish (warn once per file is noise; skip)
      }
    }
  }
  return index;
}

//#endregion

//#region Atomic write

function atomicWrite(target: string, data: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fsMod!.writeFileSync(tmp, data, "utf8");
  fsMod!.renameSync(tmp, target);
}

//#endregion

//#region Factory

export function createGoldenCache(rootDir?: string): GoldenCache {
  const root =
    rootDir !== undefined && rootDir !== "" ? rootDir
    : process.env["GOLDEN_CACHE_DIR"] !== undefined && process.env["GOLDEN_CACHE_DIR"] !== "" ? process.env["GOLDEN_CACHE_DIR"]
    : pathMod!.join(process.cwd(), ".cache", "golden");

  const cache: GoldenCache = {
    async get(key) {
      const loc = resolveKeyLocation(root, key);
      if (!loc) return null;
      const path = pathMod!.join(loc.dir, `${loc.name}.json`);
      try {
        if (!fsMod!.existsSync(path)) return null;
        const raw = fsMod!.readFileSync(path, "utf8");
        try {
          return JSON.parse(raw) as unknown;
        } catch (parseErr) {
          // Corrupt payload: treat as miss + structured warn + quarantine (DP-A §5.3).
          warnFn(
            `golden cache entry ${key} corrupt (${parseErr instanceof Error ? parseErr.message : String(parseErr)}); quarantining as ${loc.name}.corrupt.json`,
          );
          try {
            fsMod!.renameSync(path, pathMod!.join(loc.dir, `${loc.name}.corrupt.json`));
          } catch {
            /* quarantine best-effort */
          }
          return null;
        }
      } catch (err) {
        warnFn(`golden cache get failed for ${key} (${err instanceof Error ? err.message : String(err)}); treating as miss`);
        return null;
      }
    },

    async put(key, value, meta) {
      const loc = resolveKeyLocation(root, key);
      if (!loc) return;
      let payload: string;
      try {
        payload = JSON.stringify(value, null, 2) + "\n";
      } catch (err) {
        warnFn(`golden cache put failed for ${key}: value not JSON-serializable (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      try {
        fsMod!.mkdirSync(loc.dir, { recursive: true });
        atomicWrite(pathMod!.join(loc.dir, `${loc.name}.json`), payload);
      } catch (err) {
        warnFn(`golden cache put failed for ${key} (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      // Manifest update is best-effort — reads never depend on it.
      const index = readIndex(root) ?? scanIndex(root);
      index.entries[key] = {
        created_at: new Date().toISOString(),
        provider: typeof meta?.provider === "string" && meta.provider.length > 0 ? meta.provider : null,
        model: typeof meta?.model === "string" && meta.model.length > 0 ? meta.model : null,
        source: typeof meta?.source === "string" && meta.source.length > 0 ? (meta.source as CacheSource) : null,
        size_bytes: Buffer.byteLength(payload, "utf8"),
        ...(typeof meta?.explicit_key === "string" && meta.explicit_key.length > 0 ? { explicit_key: meta.explicit_key } : {}),
      };
      writeIndex(root, index);
    },

    async has(key) {
      const loc = resolveKeyLocation(root, key);
      if (!loc) return false;
      try {
        return fsMod!.existsSync(pathMod!.join(loc.dir, `${loc.name}.json`));
      } catch (err) {
        warnFn(`golden cache has failed for ${key} (${err instanceof Error ? err.message : String(err)})`);
        return false;
      }
    },

    async delete(key) {
      const loc = resolveKeyLocation(root, key);
      if (!loc) return false;
      const path = pathMod!.join(loc.dir, `${loc.name}.json`);
      let existed = false;
      try {
        existed = fsMod!.existsSync(path);
        if (existed) fsMod!.unlinkSync(path);
      } catch (err) {
        warnFn(`golden cache delete failed for ${key} (${err instanceof Error ? err.message : String(err)})`);
        return false;
      }
      try {
        const index = readIndex(root);
        if (index && key in index.entries) {
          delete index.entries[key];
          writeIndex(root, index);
        }
      } catch {
        /* manifest cleanup is best-effort */
      }
      return existed;
    },

    async list() {
      const index = readIndex(root) ?? scanIndex(root);
      const out: Record<string, ListEntry> = {};
      for (const [key, entry] of Object.entries(index.entries)) {
        out[key] = {
          created_at: String(entry.created_at ?? ""),
          provider: entry.provider ?? null,
          model: entry.model ?? null,
        };
      }
      return out;
    },

    async clear() {
      if (process.env["RES_ALLOW_CACHE_CLEAR"] !== "1") {
        warnFn("golden cache clear refused: set RES_ALLOW_CACHE_CLEAR=1 to enable (destructive)");
        return;
      }
      try {
        fsMod!.rmSync(pathMod!.join(root, "golden-index.json"), { force: true });
        fsMod!.rmSync(root, { recursive: true, force: true });
      } catch (err) {
        warnFn(`golden cache clear failed (${err instanceof Error ? err.message : String(err)})`);
      }
    },

    deriveKey: deriveKeyStandalone,
  };
  return cache;
}

//#endregion
