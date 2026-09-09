# Requirement IDs: RES-04, ASM-RES-01, PROV-02, XCUT-08
"""Thin wrapper over src/resilience/validate for the disclosure generator's
inputs — DP-J §4.1 (non-duplicate): all jsonschema logic stays in RES-04; this
module only pins the frozen contract contracts/assembly-manifest.schema.json
plus the §4.2 inline ai-log entry schema so callers never hand-roll schema
loading or re-implement validation. Python mirror of
src/provenance/provo/validate.ts. Absent/malformed schema raises loudly (repo
integrity bug, not a runtime degradation)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from src.resilience.validate import validate

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
ASSEMBLY_MANIFEST_SCHEMA_PATH = REPO_ROOT / "contracts" / "assembly-manifest.schema.json"
CATALOG_PATH = REPO_ROOT / "contracts" / "component-catalog.json"
DEFAULT_DISCLOSURE_CONFIG_PATH = HERE.parent / "config" / "disclosure.json"
DISCLOSURE_CONFIG_SCHEMA_PATH = REPO_ROOT / "contracts" / "disclosure-config.schema.json"

__all__ = [
    "AI_LOG_ENTRY_SCHEMA",
    "ASSEMBLY_MANIFEST_SCHEMA_PATH",
    "CATALOG_PATH",
    "DEFAULT_DISCLOSURE_CONFIG_PATH",
    "DISCLOSURE_CONFIG_SCHEMA_PATH",
    "REPO_ROOT",
    "load_assembly_manifest_schema",
    "validate_manifest",
    "validate_ai_log_entry",
    "validate",
]


def load_assembly_manifest_schema() -> Dict[str, Any]:
    """The authoritative manifest contract, loaded defensively."""
    return json.loads(ASSEMBLY_MANIFEST_SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_manifest(data: Any) -> Dict[str, Any]:
    """Validate one parsed AssemblyManifest against the frozen contract."""
    return validate(load_assembly_manifest_schema(), data)


# DP-J §4.2 inline shape: tool 1–40 chars, scope 5–400 chars.
AI_LOG_ENTRY_SCHEMA: Dict[str, Any] = {
    "$id": "https://chassis/contracts/ai-log-entry.inline.json",
    "title": "AiToolLogEntry",
    "type": "object",
    "additionalProperties": False,
    "required": ["tool", "scope"],
    "properties": {
        "tool": {"type": "string", "minLength": 1, "maxLength": 40},
        "scope": {"type": "string", "minLength": 5, "maxLength": 400},
    },
}


def validate_ai_log_entry(data: Any) -> Dict[str, Any]:
    """Validate one AI-tool log entry against the §4.2 inline schema."""
    return validate(AI_LOG_ENTRY_SCHEMA, data)
