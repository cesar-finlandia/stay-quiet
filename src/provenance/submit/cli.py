# Requirement IDs: SUBMIT-01..04, SUBMIT-RES-01, GOV-REU-03, XCUT-08
"""`submit` CLI — Python twin of src/provenance/submit/cli.ts (DP-J §5.4,
§9.1). Flags, help text, output bytes and exit codes stay byte-compatible:

  submit format --plan <p> --manifest <p> [--disclosure <p>]
                [--event-profile <p>] [--config <p>] [--out <p>]
  submit hygiene --manifest <p> [--include-unstaged] [--config <p>]
                 [--out hygiene-report]        # SUBMIT-05, DP-J §6
  submit:format accepted as the subcommand token (npm-script ergonomics).

Behavior contract (§8):
- Pure function of inputs; atomic `write tmp + rename` output (SUBMIT-04).
- event_profile.json defaults to ./event_profile.json when present else null
  (PROFILE-05 graceful).
- Hygiene is read-only and flag-only (SUBMIT-RES-02/NONGOAL-16); any failure
  degrades to `unavailable` and never blocks formatting (SUBMIT-RES-03).
- Outermost try/catch: exit 0 when formatting succeeded — even with field
  gaps or degraded hygiene (SUBMIT-RES-01/03); exit 1 on blocking conditions
  (output I/O failure, unhandled error) or when the secret scan is explicitly
  `flagged` (SUBMIT-05 operator block signal — the doc/report is still
  written first). Never a raw stack.
- No network, no LLM call anywhere."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.provenance.provo.validate import REPO_ROOT, validate, validate_manifest
from src.provenance.submit.extract import parse_simple_yaml, split_frontmatter
from src.provenance.submit.format import (
    HYGIENE_UNAVAILABLE_NOTE,
    format_submission,
    load_submit_config,
)
from src.provenance.submit.hygiene import (
    load_hygiene_config,
    render_hygiene_markdown,
    run_hygiene,
)

WINNING_PLAN_FRONTMATTER_SCHEMA_PATH = (
    REPO_ROOT / "contracts" / "winning-plan-frontmatter.schema.json"
)


def _warn(message: str) -> None:
    print(f"[submit] {message}", file=sys.stderr)

USAGE = """submit — Platform Submission Copy Formatter (SUBMIT)

  submit format --plan winning_project_plan.md --manifest assembly.manifest.json
                [--disclosure disclosure.md] [--event-profile event_profile.json]
                [--config config/submit.json] [--out submission.md]
  submit:format --plan <path> --manifest <path>   # alias form (npm ergonomics)
  submit hygiene --manifest assembly.manifest.json [--include-unstaged]
                 [--config config/hygiene.json] [--out hygiene-report]
  submit --help

Notes:
  --plan accepts absolute/relative paths. Missing plan/disclosure render as
  explicit gap markers (SUBMIT-RES-01) — formatting still succeeds.
  --event-profile defaults to ./event_profile.json when present (PROFILE-05);
  pass an explicit path to override.
  `format` also runs the SUBMIT-05 hygiene guard as its advisory section;
  `hygiene` runs it standalone, writing <out>.json + <out>.md. Flag-only:
  hygiene never modifies anything (NONGOAL-16).

Exit codes: 0 on ANY successful write (gaps/degraded hygiene allowed) · 1 on
output I/O failure, unhandled error, or an explicit hygiene `flagged`
verdict (SUBMIT-05 operator block signal — outputs are still written)."""


def _read_text(path: str, what: str) -> Optional[str]:
    """Read a text input; missing/unreadable -> None (gap, SUBMIT-RES-01)."""
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        _warn(f"warn: {what} not readable at {path} — rendering explicit gap (SUBMIT-RES-01)")
        return None


def _default_event_profile_path() -> Optional[str]:
    candidate = os.path.join(os.getcwd(), "event_profile.json")
    return candidate if os.path.isfile(candidate) else None


def _load_event_profile(path: Optional[str]) -> tuple:
    """Returns (submission_fields list|None, provider_labels|None, warnings).
    event_profile.json is advisory (PROFILE-05): malformed -> warn + ignore.
    provider_labels may ride alongside submission_fields as an extension of
    the profile's submission metadata; both are optional."""
    if path is None or not os.path.isfile(path):
        if path is not None:
            _warn(f"warn: event profile not found at {path} — ignored (PROFILE-05 graceful)")
        return None, None, []
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, None, [
            f"warn: event profile unreadable at {path}: {exc} — ignored (PROFILE-05 graceful)"
        ]
    fields = parsed.get("submission_fields") if isinstance(parsed, dict) else None
    labels = parsed.get("provider_labels") if isinstance(parsed, dict) else None
    warnings: List[str] = []
    if fields is not None and not isinstance(fields, list):
        warnings.append(f"warn: event profile submission_fields at {path} is not a list — ignored")
        fields = None
    if labels is not None and not isinstance(labels, dict):
        warnings.append(f"warn: event profile provider_labels at {path} is not an object — ignored")
        labels = None
    return (
        [f for f in fields if isinstance(f, str)] if fields else None,
        {str(k): str(v) for k, v in labels.items()} if labels else None,
        warnings,
    )


def _extract_manifest_providers(manifest_text: Optional[str]) -> List[str]:
    """requires_providers union over included components; invalid/missing
    manifest -> warn + empty (SUBMIT never blocks on ASM inputs)."""
    if manifest_text is None:
        return []
    try:
        parsed = json.loads(manifest_text)
        check = validate_manifest(parsed)
        if not check["valid"]:
            detail = "; ".join(f"{e['path']} {e['message']}" for e in check["errors"])
            _warn(f"warn: manifest invalid: {detail} — tech-stack providers skipped (RES-04)")
            return []
    except json.JSONDecodeError as exc:
        _warn(f"warn: manifest unparseable: {exc} — tech-stack providers skipped")
        return []
    providers: List[str] = []
    for component in parsed.get("components", []):
        if component.get("included"):
            providers.extend(component.get("requires_providers", []) or [])
    return providers


def _run_hygiene_phase(
    manifest_path: Optional[str],
    hygiene_config_flag: Optional[str],
    include_unstaged: bool,
    now: str,
) -> tuple:
    """SUBMIT-05 advisory phase shared by `format` and `hygiene` (DP-J §6.1:
    'Early-run hygiene is the same code path as late-run'). Never raises —
    every failure degrades inside run_hygiene (SUBMIT-RES-03). Returns
    (report, warnings, section_markdown) where section_markdown is the
    rendered human view minus its '# Hygiene report' top heading."""
    config, warnings = load_hygiene_config(hygiene_config_flag)
    report, hygiene_warnings = run_hygiene(
        config,
        repo_root=os.getcwd(),
        include_unstaged=include_unstaged,
        manifest_path=manifest_path,
        now=now,
    )
    warnings.extend(hygiene_warnings)
    full_md = render_hygiene_markdown(report, hygiene_warnings)
    prefix = "# Hygiene report\n\n"
    section = full_md[len(prefix):] if full_md.startswith(prefix) else full_md
    return report, warnings, section


def _write_text_atomically(target_path: str, text: str) -> str:
    out = os.path.abspath(target_path)
    directory = os.path.dirname(out) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".submit-", dir=directory)
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
    assembly_manifest.json resolved transparently (either direction).
    Private twin — kept local so this CLI never imports provo's cli module
    (which carries its own main-guard)."""
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


def _load_validated_frontmatter(plan_text: str) -> tuple:
    """Split + parse + RES-04-validate the plan's YAML frontmatter.
    Returns (frontmatter dict|None, valid: bool). Invalid/absent ->
    (None, False) — warn + proceed with body fallback (DP-J §5.1 step 1)."""
    raw, _body = split_frontmatter(plan_text)
    if raw is None:
        return None, False
    parsed = parse_simple_yaml(raw)
    try:
        schema = json.loads(WINNING_PLAN_FRONTMATTER_SCHEMA_PATH.read_text(encoding="utf-8"))
        check = validate(schema, parsed)
    except (OSError, json.JSONDecodeError) as exc:
        _warn(f"warn: cannot load winning-plan-frontmatter schema: {exc} — body fallback")
        return None, False
    if not check["valid"]:
        detail = "; ".join(f"{e['path']} {e['message']}" for e in check["errors"])
        _warn(
            "warn: winning_project_plan.md frontmatter invalid per "
            f"contracts/winning-plan-frontmatter.schema.json: {detail} — proceeding "
            "with body fallback (RES-04)"
        )
        return None, False
    return parsed, True


def cmd_format(plan_flag: str, manifest_flag: str, disclosure_flag: Optional[str],
               event_profile_flag: Optional[str], config_flag: Optional[str],
               out_flag: Optional[str]) -> int:
    plan_text = _read_text(plan_flag, "winning project plan")
    manifest_text = _read_text(resolve_manifest_path(manifest_flag), "manifest")
    disclosure_text = _read_text(disclosure_flag, "disclosure") if disclosure_flag else None
    if disclosure_flag is None:
        disclosure_text = _read_text("disclosure.md", "disclosure") if os.path.isfile("disclosure.md") else None

    config, config_warnings = load_submit_config(config_flag)
    for warning in config_warnings:
        _warn(warning)
    fields, profile_labels, profile_warnings = _load_event_profile(
        event_profile_flag if event_profile_flag is not None else _default_event_profile_path()
    )
    for warning in profile_warnings:
        _warn(warning)
    # provider_labels: explicit config mapping wins over the advisory
    # event-profile mapping (same precedence as fieldLabels, DP-J §5.1/§5.3).
    config_provider_labels = config.get("provider_labels")
    provider_labels = {
        **(profile_labels or {}),
        **(config_provider_labels if isinstance(config_provider_labels, dict) else {}),
    }

    providers = _extract_manifest_providers(manifest_text)
    frontmatter, frontmatter_valid = _load_validated_frontmatter(plan_text or "")
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # SUBMIT-05 advisory phase — same code path as the standalone `hygiene`
    # command (DP-J §6.1). Disabled via submit config → template section is
    # stripped downstream and no scan runs.
    hygiene_enabled = bool(config.get("hygiene", {}).get("enabled", True))
    hygiene_report = None
    hygiene_section: Optional[str] = HYGIENE_UNAVAILABLE_NOTE
    if hygiene_enabled:
        hygiene_report, hygiene_warnings, hygiene_section = _run_hygiene_phase(
            resolve_manifest_path(manifest_flag) if manifest_text is not None else None,
            None,
            False,
            now,
        )
        for warning in hygiene_warnings:
            _warn(warning)

    result = format_submission(
        plan_text or "",
        providers,
        disclosure_text,
        config,
        event_profile_submission_fields=fields,
        provider_labels=provider_labels,
        frontmatter=frontmatter,
        frontmatter_valid=frontmatter_valid,
        hygiene_summary=hygiene_section,
        now=now,
    )
    out_path = out_flag or config.get("output", {}).get("path", "submission.md")
    written = _write_text_atomically(out_path, result["markdown"])
    print(
        f"submission copy: {written} "
        f"({len(result['not_extracted_fields'])} field(s) marked not extracted)"
    )
    if hygiene_report is not None:
        overall = hygiene_report["overall"]
        verdict = "FLAGGED" if overall == "flagged" else overall
        print(f"hygiene (advisory): {verdict} (SUBMIT-05 — see '## Hygiene' section)")
        # Explicit SUBMIT-05 flag semantics (§8): operator decides to block;
        # the submission doc is still fully written first.
        if overall == "flagged":
            return 1
    print("ok — re-runnable pure function of plan+manifest+disclosure+config (SUBMIT-04)")
    return 0


def cmd_hygiene(manifest_flag: Optional[str], include_unstaged: bool,
                config_flag: Optional[str], out_flag: Optional[str]) -> int:
    """Standalone SUBMIT-05 run (DP-J §6.1): writes <out>.json (frozen
    contracts/hygiene-report.schema.json shape) + <out>.md (human view).
    Exit 0 clean/unavailable; 1 flagged (operator block signal)."""
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    resolved_manifest = resolve_manifest_path(manifest_flag) if manifest_flag else None
    report, warnings, _section = _run_hygiene_phase(
        resolved_manifest, config_flag, include_unstaged, now
    )
    for warning in warnings:
        _warn(warning)
    base = out_flag or "hygiene-report"
    json_path = base if base.endswith(".json") else f"{base}.json"
    md_path = (json_path[:-5] if json_path.endswith(".json") else base) + ".md"
    written_json = _write_text_atomically(json_path, json.dumps(report, indent=2) + "\n")
    full_md = render_hygiene_markdown(report, warnings)
    written_md = _write_text_atomically(md_path, full_md)
    scan_status = report["secret_scan"]["status"]
    dist_status = report["commit_distribution"]["status"]
    print(
        f"hygiene report: {written_json} + {written_md} "
        f"(secret scan {scan_status}, commit distribution {dist_status}, "
        f"overall {report['overall']})"
    )
    return 1 if report["overall"] == "flagged" else 0


def main(argv: Optional[List[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    normalized = ["format" if a == "submit:format" else a for a in argv]
    if not argv or "--help" in argv or "-h" in argv:
        print(USAGE)
        return 1 if not argv else 0

    import argparse

    parser = argparse.ArgumentParser(prog="submit", add_help=False)
    parser.add_argument(
        "command", choices=["format", "submit:format", "hygiene"]
    )
    parser.add_argument("--plan", default=None)
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--disclosure", default=None)
    parser.add_argument("--event-profile", default=None)
    parser.add_argument("--config", default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--include-unstaged", action="store_true", default=False)
    try:
        args = parser.parse_args(normalized)
    except SystemExit:
        return 1

    try:
        if args.command == "hygiene":
            return cmd_hygiene(
                args.manifest,
                args.include_unstaged,
                args.config,
                args.out,
            )
        return cmd_format(
            args.plan or "winning_project_plan.md",
            args.manifest or "assembly.manifest.json",
            args.disclosure,
            args.event_profile,
            args.config,
            args.out,
        )
    except OSError as exc:
        # §8 outermost guard: clear message, never a raw stack.
        print(f"ERROR: submit {args.command} failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 — outermost catch per DP-J §8
        print(f"ERROR: submit {args.command} failed unexpectedly: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
