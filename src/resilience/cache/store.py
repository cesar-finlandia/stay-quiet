# Requirement IDs: RES-05, RES-RES-02, RES-RES-03, GOV-MIN-04, XCUT-08
"""Golden-path cache store (DP-A §5) — file-based JSON KV, dependency-free.

Python mirror of cache/store.ts (master_blueprint.md §6.7: no SQLite, no new
runtime dep). Layout: <root>/golden-index.json manifest + one JSON file per
key; replay subspace under <root>/replay/ addressed as keys prefixed
"replay::". Individual files are the source of truth for reads (index loss is
recoverable by scanning *.json). Every public method is RES-RES-03 guarded
internally: FS errors log + return miss/False, never raise to the caller.
Domain-free (GOV-REU-02); standard library only (RES-REU-01).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Literal, Optional, Union

INDEX_VERSION = "1.0.0"
REPLAY_PREFIX = "replay::"

CacheSource = Literal["mock", "data", "manual"]

_WARN_SINK: Any = lambda message: print(f"[resilience] warn: {message}", flush=True)  # noqa: E731


def _warn(message: str) -> None:
    _WARN_SINK(message)


def set_cache_warn_logger(fn: Any) -> Any:
    """Test seam: override the warn sink. Returns the previous sink."""
    global _WARN_SINK
    prev = _WARN_SINK
    _WARN_SINK = fn
    return prev


#region Key derivation (DP-A §5.2)

BUFFER_TAG = "__buffer_sha256__"


def _sha256_hex(data: Union[str, bytes]) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _normalize_value(value: Any) -> Any:
    """Replace binary buffers with sha256 placeholders (content-addressable, DP-A §5.2)."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {BUFFER_TAG: _sha256_hex(bytes(value))}
    if isinstance(value, list):
        return [_normalize_value(v) for v in value]
    if isinstance(value, tuple):
        return [_normalize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalize_value(v) for k, v in value.items()}
    return value


def stable_json_stringify(value: Any) -> str:
    """JSON with object keys sorted lexicographically and no whitespace (DP-A §5.2)."""
    return json.dumps(_normalize_value(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def derive_key_standalone(
    provider: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Any = None,
    *,
    explicit_key: Optional[str] = None,
) -> str:
    """Canonical deterministic key (pure — no timestamp, no randomness):

    key = sha256( provider + "|" + model + "|" + input_hash )
    input_hash = sha256( stable_json_stringify( normalized_input ) )

    Provider/model are trimmed + lowercased; result is 64-char lowercase hex.
    Explicit-key mode hashes the caller kebab-case key once (DP-A §5.2).
    """
    if explicit_key is not None:
        return _sha256_hex(explicit_key)
    assert provider is not None and model is not None, "derive_key needs provider+model or explicit_key"
    p = provider.strip().lower()
    m = model.strip().lower()
    input_hash = _sha256_hex(stable_json_stringify(_normalize_value(prompt)))
    return _sha256_hex(f"{p}|{m}|{input_hash}")


#endregion

#region Index helpers (golden-index.json — manifest for offline listing only)


def _empty_index() -> Dict[str, Any]:
    return {"version": INDEX_VERSION, "entries": {}}


def _read_index(root: Path) -> Optional[Dict[str, Any]]:
    path = root / "golden-index.json"
    try:
        if not path.exists():
            return None
        parsed = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict) or not isinstance(parsed.get("entries"), dict):
            return None
        return {"version": str(parsed.get("version", INDEX_VERSION)), "entries": parsed["entries"]}
    except (OSError, ValueError) as err:
        _warn(f"golden-index.json unreadable or corrupt ({err}); recovering by scanning *.json")
        return None


def _write_index(root: Path, index: Dict[str, Any]) -> None:
    """Atomic manifest write; failures are logged, never raised (files are source of truth)."""
    try:
        root.mkdir(parents=True, exist_ok=True)
        _atomic_write(root / "golden-index.json", json.dumps(index, indent=2) + "\n")
    except OSError as err:
        _warn(f"golden-index.json write failed ({err}); entry files remain authoritative")


def _scan_index(root: Path) -> Dict[str, Any]:
    """Rebuild a logical index from entry files when golden-index.json is lost/corrupt."""
    index = _empty_index()
    for rel_dir, prefix in ((".", ""), ("replay", REPLAY_PREFIX)):
        d = root / rel_dir
        if not d.is_dir():
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json") or ".corrupt." in name or name == "golden-index.json":
                continue
            try:
                stat = (d / name).stat()
                key = f"{prefix}{name[: -len('.json')]}"
                index["entries"][key] = {
                    "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    "provider": None,
                    "model": None,
                    "source": None,
                    "size_bytes": stat.st_size,
                }
            except OSError:
                continue
    return index


def _atomic_write(target: Path, data: str) -> None:
    """Write tmp file + rename so a crash never leaves partial files (DP-A §5.3)."""
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=f"{target.name}.tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.replace(tmp_name, target)
    finally:
        if os.path.exists(tmp_name):
            try:
                os.unlink(tmp_name)
            except OSError:
                pass


def _resolve_key_location(root: Path, key: str):
    name = key[len(REPLAY_PREFIX):] if key.startswith(REPLAY_PREFIX) else key
    directory = root / "replay" if key.startswith(REPLAY_PREFIX) else root
    if len(name) != 64 or any(c not in "0123456789abcdef" for c in name):
        _warn(f"golden cache key invalid ({key[:80]}), expecting 64-char lowercase hex")
        return None
    return directory, name


#endregion

#region GoldenCache (DP-A §5.3 read/write API)


class GoldenCache:
    """File-based JSON KV store. All methods are RES-RES-03 guarded: FS errors
    log + return miss/False, never raise to the caller."""

    def __init__(self, root_dir: Optional[str] = None) -> None:
        env_dir = os.environ.get("GOLDEN_CACHE_DIR", "")
        if root_dir:
            chosen = root_dir
        elif env_dir:
            chosen = env_dir
        else:
            chosen = os.path.join(os.getcwd(), ".cache", "golden")
        self.root = Path(chosen)

    # -- read/write API -----------------------------------------------------

    def get(self, key: str) -> Optional[Any]:  # noqa: A003
        loc = _resolve_key_location(self.root, key)
        if loc is None:
            return None
        directory, name = loc
        path = directory / f"{name}.json"
        try:
            if not path.exists():
                return None
            raw = path.read_text(encoding="utf-8")
            try:
                return json.loads(raw)
            except ValueError as parse_err:
                # Corrupt payload: miss + structured warn + quarantine (DP-A §5.3).
                _warn(f"golden cache entry {key} corrupt ({parse_err}); quarantining as {name}.corrupt.json")
                try:
                    os.replace(path, directory / f"{name}.corrupt.json")
                except OSError:
                    pass
                return None
        except OSError as err:
            _warn(f"golden cache get failed for {key} ({err}); treating as miss")
            return None

    def put(
        self,
        key: str,
        value: Any,
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        loc = _resolve_key_location(self.root, key)
        if loc is None:
            return
        directory, name = loc
        meta = meta or {}
        try:
            payload = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        except (TypeError, ValueError) as err:
            _warn(f"golden cache put failed for {key}: value not JSON-serializable ({err})")
            return
        try:
            directory.mkdir(parents=True, exist_ok=True)
            _atomic_write(directory / f"{name}.json", payload)
        except OSError as err:
            _warn(f"golden cache put failed for {key} ({err})")
            return
        # Manifest update is best-effort — reads never depend on it.
        index = _read_index(self.root) or _scan_index(self.root)
        source = meta.get("source")
        entry: Dict[str, Any] = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "provider": meta.get("provider") or None,
            "model": meta.get("model") or None,
            "source": source if isinstance(source, str) and source else None,
            "size_bytes": len(payload.encode("utf-8")),
        }
        explicit_key = meta.get("explicit_key")
        if isinstance(explicit_key, str) and explicit_key:
            entry["explicit_key"] = explicit_key
        index["entries"][key] = entry
        _write_index(self.root, index)

    def has(self, key: str) -> bool:
        loc = _resolve_key_location(self.root, key)
        if loc is None:
            return False
        directory, name = loc
        try:
            return (directory / f"{name}.json").exists()
        except OSError as err:
            _warn(f"golden cache has failed for {key} ({err})")
            return False

    def derive_key(
        self,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        prompt: Any = None,
        *,
        explicit_key: Optional[str] = None,
    ) -> str:
        return derive_key_standalone(provider, model, prompt, explicit_key=explicit_key)

    def delete(self, key: str) -> bool:
        loc = _resolve_key_location(self.root, key)
        if loc is None:
            return False
        directory, name = loc
        path = directory / f"{name}.json"
        existed = False
        try:
            existed = path.exists()
            if existed:
                os.unlink(path)
        except OSError as err:
            _warn(f"golden cache delete failed for {key} ({err})")
            return False
        try:
            index = _read_index(self.root)
            if index and key in index["entries"]:
                del index["entries"][key]
                _write_index(self.root, index)
        except Exception:  # noqa: BLE001 — manifest cleanup is best-effort
            pass
        return existed

    def list(self) -> Dict[str, Dict[str, Any]]:  # noqa: A003
        index = _read_index(self.root) or _scan_index(self.root)
        out: Dict[str, Dict[str, Any]] = {}
        for key, entry in index["entries"].items():
            out[key] = {
                "created_at": entry.get("created_at", ""),
                "provider": entry.get("provider"),
                "model": entry.get("model"),
            }
        return out

    def clear(self) -> None:
        """Test-only; gated behind RES_ALLOW_CACHE_CLEAR=1 (no-op otherwise)."""
        if os.environ.get("RES_ALLOW_CACHE_CLEAR") != "1":
            _warn("golden cache clear refused: set RES_ALLOW_CACHE_CLEAR=1 to enable (destructive)")
            return
        try:
            import shutil

            shutil.rmtree(self.root, ignore_errors=True)
        except OSError as err:
            _warn(f"golden cache clear failed ({err})")


def create_golden_cache(root_dir: Optional[str] = None) -> GoldenCache:
    """Factory per DP-A §5.3 — default root '<cwd>/.cache/golden', overridable
    via GOLDEN_CACHE_DIR env or the ``root_dir`` param."""
    return GoldenCache(root_dir)


#endregion
