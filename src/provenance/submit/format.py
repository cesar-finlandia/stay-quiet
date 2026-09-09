# Requirement IDs: SUBMIT-04, SUBMIT-03, SUBMIT-RES-01, GOV-RES-02, XCUT-08
"""SUBMIT-04 submission-doc assembler — Python twin of
src/provenance/submit/format.ts (DP-J §5.4). `format_submission` is a PURE
function of plan extraction + manifest providers + disclosure text + event
profile + config (+ injected clock): re-running after editing any input
reproduces the doc modulo generated_at. No side effects beyond the caller's
atomic write of the returned markdown."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.provenance.provo.validate import REPO_ROOT, validate
from src.provenance.submit.embed import embed_disclosure
from src.provenance.submit.labels import resolve_labels
from src.provenance.submit.extract import GAP_MARKER

HERE = Path(__file__).resolve().parent
DEFAULT_SUBMIT_CONFIG_PATH = HERE.parent / "config" / "submit.json"
SUBMIT_TEMPLATE_PATH = HERE / "templates" / "submission.template.md"
SUBMIT_CONFIG_SCHEMA_PATH = REPO_ROOT / "contracts" / "submit-config.schema.json"

# Exact degraded-hygiene note (DP-J §8 / submission.template.md).
HYGIENE_UNAVAILABLE_NOTE = (
    "> Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06)."
)

# Safe defaults (GOV-RES-02) — identical to the checked-in generic config.
DEFAULT_CONFIG: Dict[str, Any] = {
    "version": "1.0.0",
    "output": {"path": "submission.md", "format": "markdown"},
    "fieldLabels": {
        "tagline": "Tagline",
        "target_user": "Target User",
        "why_ai": "Why AI",
        "tech_stack": "Tech Stack",
        "disclosure": "Disclosure / Provenance",
    },
    "hygiene": {"enabled": True, "reportPath": "hygiene-report.md"},
    "disclosure": {"include_excluded_footnote": False},
}


def load_submit_config(config_path: Optional[str]) -> Dict[str, Any]:
    """Load + RES-04-validate config/submit.json. Absent default -> pure
    DEFAULT_CONFIG; explicit-but-malformed -> warn + safe defaults, never
    crash (GOV-RES-02). Returns (config, warnings)."""
    path = Path(config_path) if config_path else DEFAULT_SUBMIT_CONFIG_PATH
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        schema = json.loads(SUBMIT_CONFIG_SCHEMA_PATH.read_text(encoding="utf-8"))
        result = validate(schema, parsed)
    except (OSError, json.JSONDecodeError) as exc:
        if config_path is None and not path.exists():
            return dict(DEFAULT_CONFIG), []
        return (
            dict(DEFAULT_CONFIG),
            [f"warn: submit config unreadable at {path}: {exc} — using safe defaults (GOV-RES-02)"],
        )
    if not result["valid"]:
        detail = "; ".join(f"{e['path']} {e['message']}" for e in result["errors"])
        return (
            dict(DEFAULT_CONFIG),
            [f"warn: submit config invalid at {path}: {detail} — using safe defaults (GOV-RES-02)"],
        )
    return parsed, []


_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_HYGIENE_SECTION_RE = re.compile(r"\n## Hygiene \(advisory\)\n.*?(?=\n## |\Z)", re.DOTALL)


def _render(template: str, replacements: Dict[str, str]) -> str:
    out = template
    for key, value in replacements.items():
        out = out.replace("{{" + key + "}}", value)
    return out


def format_submission(
    plan_text: str,
    manifest_providers: List[str],
    disclosure_text: Optional[str],
    config: Dict[str, Any],
    event_profile_submission_fields: Optional[List[str]] = None,
    provider_labels: Optional[Dict[str, str]] = None,
    frontmatter: Optional[Dict[str, Any]] = None,
    frontmatter_valid: bool = False,
    hygiene_summary: Optional[str] = None,
    now: Optional[str] = None,
) -> Dict[str, Any]:
    """Pure SUBMIT-04 assembly → {markdown, frontmatter, not_extracted_fields}.

    Every input is already text/dict — no FS access here. `now` injects the
    ISO-8601 generated_at stamp for determinism; None means caller-supplied
    clock is required upstream (CLI passes datetime.now(timezone.utc)).
    Gapped canonical fields render the exact SUBMIT-RES-01 gap marker and are
    tracked in the doc frontmatter's not_extracted_fields."""
    from src.provenance.submit.extract import extract_fields  # local: avoids cycle at import time

    extracted = extract_fields(
        plan_text,
        manifest_providers,
        provider_labels=provider_labels,
        frontmatter=frontmatter,
        frontmatter_valid=frontmatter_valid,
    )
    labels = resolve_labels(config.get("fieldLabels"), event_profile_submission_fields)
    disclosure = embed_disclosure(disclosure_text)

    not_extracted: List[str] = list(extracted["not_extracted_fields"])
    if disclosure["missing"]:
        not_extracted.append("disclosure")

    def value(name: str) -> str:
        raw = extracted[name]
        return raw if name != "tech_stack" else ", ".join(raw)

    replacements: Dict[str, str] = {
        "generated_at": now or "",
        "not_extracted_fields": json.dumps(not_extracted),
    }
    for canonical in ("tagline", "target_user", "why_ai", "tech_stack"):
        text = value(canonical)
        replacements[f"label_{canonical}"] = labels[canonical]
        replacements[canonical] = text if text else GAP_MARKER
    replacements["label_disclosure"] = labels["disclosure"]
    replacements["disclosure"] = str(disclosure["text"])
    replacements["hygiene_summary"] = hygiene_summary or HYGIENE_UNAVAILABLE_NOTE

    body = _COMMENT_RE.sub("", SUBMIT_TEMPLATE_PATH.read_text(encoding="utf-8"))
    body = _render(body, replacements).strip()
    if not config.get("hygiene", {}).get("enabled", True):
        body = _HYGIENE_SECTION_RE.sub("", body).strip()

    frontmatter_yaml = (
        "---\n"
        'version: "1.0.0"\n'
        f'generated_at: "{now or ""}"\n'
        f"not_extracted_fields: {json.dumps(not_extracted)}\n"
        "---"
    )
    markdown = f"{frontmatter_yaml}\n\n{body}\n"
    return {
        "markdown": markdown,
        "frontmatter": frontmatter_yaml,
        "not_extracted_fields": not_extracted,  # type: ignore[dict-item]
    }


__all__ = [
    "GAP_MARKER",
    "HYGIENE_UNAVAILABLE_NOTE",
    "DEFAULT_SUBMIT_CONFIG_PATH",
    "SUBMIT_CONFIG_SCHEMA_PATH",
    "DEFAULT_CONFIG",
    "load_submit_config",
    "format_submission",
]
