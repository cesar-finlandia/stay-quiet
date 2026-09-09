# Requirement IDs: PROV-01, PROV-03, PROV-05, PROV-RES-01, GOV-RES-02, XCUT-08
"""`provo` CLI — Python twin of src/provenance/provo/cli.ts (DP-J §9.1).
Flags, help text, output bytes and exit codes stay byte-compatible:
  provo generate --manifest <p> [--ai-log <p>|tool:scope ...] [--out <p>] [--config <p>]
  provo summary  --manifest <p> [--out <p>]
  provo:generate / provo:summary accepted as the subcommand token
  (npm-script ergonomics per DP-J §9.1).

Behavior contract (§8):
- Atomic `write tmp + rename` for every output; no partial files ever.
- `generate` writes disclosure.md AND architecture-summary.md plus the
  identical-bytes architecture_summary.txt alias (one source_manifest_hash).
- Outermost try/catch: clear message; exit 1 ONLY when manifest validation or
  catalog coverage blocked generation; successful writes exit 0 even with
  warnings.
- No network, no LLM call anywhere (PROV-REU-01)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.provenance.provo.generate import (
    CatalogError,
    ManifestValidationError,
    generate_disclosure,
    parse_ai_log,
    parse_and_validate_manifest,
)
from src.provenance.provo.summary import build_architecture_summary
from src.provenance.provo.validate import (
    CATALOG_PATH,
    DEFAULT_DISCLOSURE_CONFIG_PATH,
    DISCLOSURE_CONFIG_SCHEMA_PATH,
    load_assembly_manifest_schema,
    validate,
    validate_ai_log_entry,
)

USAGE = """provo — Disclosure Generator (PROV)

  provo generate --manifest assembly.manifest.json [--ai-log ai_tools.json] [--out disclosure.md] [--config config/disclosure.json]
  provo summary  --manifest assembly.manifest.json [--out architecture-summary.md]
  provo:generate --manifest <path>        # alias form (npm script ergonomics)
  provo:summary  --manifest <path>        # alias form
  provo --help

Notes:
  --manifest accepts absolute/relative paths; the DP-G §3.1 alias filename
  assembly_manifest.json is resolved automatically when the dotted name is absent.
  --ai-log accepts a JSON file path and/or repeated inline tool:scope pairs
  (e.g. --ai-log Cursor:"scaffolded tests"). Malformed entries warn + skip;
  an empty log simply omits the AI assistance section (PROV-RES-01).

Exit codes: 0 on ANY successful write (warnings allowed) · 1 when manifest
validation or catalog coverage blocked generation (ASM-RES-01, accuracy over
availability) · 1 on output I/O failure."""


def _warn(message: str) -> None:
    print(f"[provo] {message}", file=sys.stderr)


def _write_text_atomically(target_path: str, text: str) -> str:
    out = os.path.abspath(target_path)
    directory = os.path.dirname(out) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".provo-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.replace(tmp, out)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return out


def resolve_manifest_path(manifest_path: str) -> str:
    """DP-G §3.1 alias: dotted assembly.manifest.json ↔ underscore
    assembly_manifest.json resolved transparently (either direction)."""
    if os.path.exists(manifest_path):
        return manifest_path
    directory = os.path.dirname(manifest_path)
    base = os.path.basename(manifest_path)
    swapped = (
        base.replace("_manifest.json", ".manifest.json")
        if base.endswith("_manifest.json")
        else base.replace(".manifest.json", "_manifest.json")
    )
    if swapped != base:
        aliased = os.path.join(directory, swapped) if directory else swapped
        if os.path.exists(aliased):
            return aliased
    return manifest_path  # let the read fail with the user's original path


def _load_disclosure_config(config_path: Optional[str]) -> Dict[str, Any]:
    path = config_path or str(DEFAULT_DISCLOSURE_CONFIG_PATH)
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError:
        if config_path is None:
            return {}  # checked-in default absent -> pure defaults
        _warn(f"warn: disclosure config not found at {path} — using safe defaults (GOV-RES-02)")
        return {}
    try:
        parsed = json.loads(raw)
        schema = json.loads(DISCLOSURE_CONFIG_SCHEMA_PATH.read_text(encoding="utf-8"))
        res = validate(schema, parsed)
        if not res["valid"]:
            detail = "; ".join(f"{e['path']} {e['message']}" for e in res["errors"])
            _warn(f"warn: disclosure config invalid at {path}: {detail} — using safe defaults (GOV-RES-02)")
            return {}
        return parsed
    except (json.JSONDecodeError, OSError):
        _warn(f"warn: disclosure config unreadable at {path} — using safe defaults (GOV-RES-02)")
        return {}


def _load_catalog() -> Dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def resolve_ai_log_inputs(values: List[str]) -> Tuple[Optional[str], List[str]]:
    """--ai-log values may be a JSON file path OR inline `tool:scope`
    (repeated). Returns the combined log serialized as one JSON array string
    (or None when empty) plus skip-warnings — malformed entries never block
    (PROV-RES-01)."""
    entries: List[Dict[str, Any]] = []
    warnings: List[str] = []
    for value in values:
        if os.path.isfile(value):
            try:
                with open(value, "r", encoding="utf-8") as handle:
                    text = handle.read()
            except OSError:
                warnings.append(f"warn: cannot read ai-log file {value} — skipped (PROV-RES-01)")
                continue
            # Reuse the generator's parser for uniform warn+skip semantics.
            file_entries, file_warnings = parse_ai_log(text)
            warnings.extend(w.replace("warn: ", f"warn: {value}: ", 1) for w in file_warnings)
            entries.extend(file_entries)
            continue
        # Inline shorthand tool:scope — split on the FIRST colon; surrounding
        # quotes on the scope are stripped (§9.1 Cursor:"scaffolded tests").
        idx = value.find(":")
        if idx <= 0:
            warnings.append(f'warn: ai-log value "{value}" is neither a file nor tool:scope — skipped')
            continue
        tool = value[:idx]
        scope = value[idx + 1 :]
        if len(scope) >= 2 and scope[0] == scope[-1] and scope[0] in ("'", '"'):
            scope = scope[1:-1]
        check = validate_ai_log_entry({"tool": tool, "scope": scope})
        if check["valid"]:
            entries.append({"tool": tool, "scope": scope})
        else:
            detail = "; ".join(f"{e['path']} {e['message']}" for e in check["errors"])
            warnings.append(f"warn: inline ai-log entry skipped (malformed): {detail} (GOV-RES-02)")
    return (json.dumps(entries, indent=2) if entries else None), warnings


def _read_manifest_bytes(manifest_flag: str) -> Tuple[str, str]:
    resolved = resolve_manifest_path(manifest_flag)
    try:
        with open(resolved, "r", encoding="utf-8") as handle:
            return handle.read(), resolved
    except OSError as exc:
        raise ManifestValidationError(
            "/",
            f"cannot read manifest at {resolved} ({exc}) — run assembly first (ASM-04)",
            "manifest_unreadable",
        ) from exc


def cmd_generate(manifest_flag: str, ai_log_values: List[str], out_path: str,
                 config_path: Optional[str]) -> int:
    manifest_bytes, _path = _read_manifest_bytes(manifest_flag)
    ai_log_json, ai_warnings = resolve_ai_log_inputs(ai_log_values)
    for warning in ai_warnings:
        _warn(warning)

    catalog = _load_catalog()
    config = _load_disclosure_config(config_path)
    result = generate_disclosure(manifest_bytes, ai_log_json, catalog, config)

    written_disclosure = _write_text_atomically(out_path, result["disclosure_text"] + "\n")
    summary_dir = os.path.dirname(os.path.abspath(out_path))
    written_summary_md = _write_text_atomically(
        os.path.join(summary_dir, "architecture-summary.md"),
        result["architecture_summary"] + "\n",
    )
    written_summary_txt = _write_text_atomically(
        os.path.join(summary_dir, "architecture_summary.txt"),
        result["architecture_summary"] + "\n",
    )

    print(
        f"disclosure: {written_disclosure} ({len(result['components_reused'])} component(s) reused, "
        f"manifest hash {result['source_manifest_hash'][:12]}…)"
    )
    print(f"architecture summary (PROV-05): {written_summary_md}")
    print(f"architecture summary alias: {written_summary_txt}")
    for warning in result["warnings"]:
        _warn(warning)
    print("ok — disclosure is the single source for DECKGEN-02 / SUBMIT-02 / FAQDEF-02 (contract #8)")
    return 0


def cmd_summary(manifest_flag: str, out_path: str, config_path: Optional[str]) -> int:
    manifest_bytes, _path = _read_manifest_bytes(manifest_flag)
    # Validate via the shared path so invalid manifests block here too.
    manifest = parse_and_validate_manifest(manifest_bytes)

    catalog = _load_catalog()
    config = _load_disclosure_config(config_path)
    summary_text = build_architecture_summary(manifest, catalog, config)

    written_summary_md = _write_text_atomically(out_path, summary_text + "\n")
    summary_dir = os.path.dirname(os.path.abspath(out_path))
    written_summary_txt = _write_text_atomically(
        os.path.join(summary_dir, "architecture_summary.txt"),
        summary_text + "\n",
    )
    print(f"architecture summary (PROV-05): {written_summary_md}")
    print(f"architecture summary alias: {written_summary_txt}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    # Colon-alias acceptance: `provo:generate` / `provo:summary` subcommand token.
    normalized = ["generate" if a == "provo:generate" else "summary" if a == "provo:summary" else a for a in argv]
    if not argv or "--help" in argv or "-h" in argv:
        print(USAGE)
        return 1 if not argv else 0

    parser = argparse.ArgumentParser(prog="provo", add_help=False)
    parser.add_argument("command", choices=["generate", "summary", "provo:generate", "provo:summary"])
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--ai-log", action="append", default=[], dest="ai_log")
    parser.add_argument("--out", default=None)
    parser.add_argument("--config", default=None)
    try:
        args = parser.parse_args(normalized)
    except SystemExit:
        return 1

    command = args.command.split(":")[-1]
    manifest_flag = args.manifest or os.path.join(os.getcwd(), "assembly.manifest.json")

    try:
        if command == "generate":
            return cmd_generate(
                manifest_flag,
                list(args.ai_log),
                args.out or "disclosure.md",
                args.config,
            )
        if command == "summary":
            return cmd_summary(manifest_flag, args.out or "architecture-summary.md", args.config)
        print(USAGE)
        return 1
    except ManifestValidationError as exc:
        # §8 outermost guard: clear message; exit 1 only when generation was
        # BLOCKED (manifest validation / catalog coverage). Never a raw stack.
        print(f"ERROR: invalid manifest at {exc.path}: {exc}", file=sys.stderr)
        return 1
    except CatalogError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"ERROR: provo {command} failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
