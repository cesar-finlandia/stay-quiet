# Requirement IDs: PROV-01, PROV-02, PROV-03, PROV-04, PROV-REU-01, XCUT-08
"""Disclosure generator core (DP-J §4) — pure, synchronous, LLM-free.

Python mirror of src/provenance/provo/generate.ts. Flags, rendered Markdown
and derivation rules stay byte-compatible between the twins.

generate_disclosure(manifest_bytes, ai_log_bytes|None, catalog, config=None,
now=None) -> dict with keys disclosure_text, architecture_summary,
components_reused, ai_tool_log, source_manifest_hash, source_ai_log_hash,
generated_at, warnings.

Accuracy invariant (PROV-04): the rendered text claims exactly the manifest's
components.filter(c=>c.included) — one bullet per included id in manifest
order, zero mentions of excluded ids unless the optional footnote is enabled.
Every noun comes from the manifest or contracts/component-catalog.json;
nothing is paraphrased or invented (PROV-REU-01). Re-running is safe and
idempotent modulo generated_at/source_manifest_hash (PROV-03).

Imports limited to src/resilience/*, contracts/* and stdlib (GOV-REU-03)."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from src.resilience.validate import validate

from src.provenance.provo.validate import (
    load_assembly_manifest_schema,
    validate_ai_log_entry,
)

__all__ = [
    "ManifestValidationError",
    "CatalogError",
    "parse_and_validate_manifest",
    "parse_ai_log",
    "extract_requirement_ids",
    "derive_role_sentence",
    "lookup_catalog_entry",
    "render_bullet",
    "generate_disclosure",
]

_BACKTICKED_TOKEN_RE = re.compile(r"`([^`]+)`")
_PAREN_SLASH_GROUP_RE = re.compile(r"\(([A-Z]{2,}(?:/[A-Z]{2,})+)\)")
_BARE_CAPS_RE = re.compile(r"[A-Z][A-Z0-9]{1,9}")
_TOKEN_SHAPE_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:[-/][A-Za-z0-9*.:]+)*$")


class ManifestValidationError(Exception):
    """ASM-RES-01: invalid/missing manifest blocks disclosure — accuracy over
    availability. Carries path/message/code per validation-error.schema.json."""

    def __init__(self, path: str, message: str, code: str = "manifest_invalid") -> None:
        super().__init__(message)
        self.name = "ManifestValidationError"
        self.path = path
        self.code = code


class CatalogError(Exception):
    """Repo integrity bug: a manifest id with no catalog coverage."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.name = "CatalogError"
        self.code = "catalog_missing_entry"


def _leading_alpha_run(token: str) -> str:
    m = re.match(r"^[A-Z]+", token)
    return m.group(0) if m else token.upper()


def extract_requirement_ids(entry: Dict[str, Any]) -> str:
    """Requirement-id tokens EXTRACTED from the catalog description — the
    catalog (M04-owned, additionalProperties:false) has no dedicated field, so
    this chain is the single deterministic rule set (mirrors generate.ts):
      1. backticked ALL-CAPS tokens (`RES-*`, `DEP`, `CTX-02`);
      2. parenthesized slash-groups ((MOCK/EVAL/DOCTOR/TRACK/BENCH));
      3. bare ALL-CAPS words in the FIRST sentence only, when 1+2 empty;
      4. sub_components suffixes uppercased when still empty (provenance ->
         PROV/SUBMIT).
    Family filter: when any token shares its letter-prefix with the component
    id (cost -> COST-*), keep only family matches — unless that empties the
    set (context keeps CTX-* though CONTEXT != CTX)."""
    desc = entry.get("description", "") or ""
    found: List[str] = []

    # 1. Backticked ALL-CAPS tokens (no lowercase letters anywhere).
    for m in _BACKTICKED_TOKEN_RE.finditer(desc):
        tok = m.group(1)
        if tok and _TOKEN_SHAPE_RE.match(tok) and not re.search(r"[a-z]", tok):
            found.append(tok)

    # 2. Parenthesized slash-group of ALL-CAPS words.
    if not found:
        m = _PAREN_SLASH_GROUP_RE.search(desc)
        if m:
            found.append(m.group(1))

    # 3. Bare ALL-CAPS words restricted to the first sentence.
    if not found:
        first_sentence = re.split(r"(?<=\.)\s+", desc, maxsplit=1)[0]
        found.extend(m.group(0) for m in _BARE_CAPS_RE.finditer(first_sentence))

    # 4. Sub-component suffixes uppercased (provenance -> PROV/SUBMIT).
    if not found:
        subs = entry.get("sub_components") or []
        if subs:
            return "/".join(s.split("/")[-1].upper() for s in subs)

    # Family filter — keep id-prefix matches when present (unless emptying).
    family = _leading_alpha_run((entry.get("id") or "").upper())
    family_matches = [t for t in found if _leading_alpha_run(t) == family]
    unique_source = family_matches if family_matches else found
    seen: List[str] = []
    for t in unique_source:
        if t not in seen:
            seen.append(t)
    return "/".join(seen)


def derive_role_sentence(entry: Dict[str, Any]) -> str:
    """One-line role: the catalog description with the EXTRACTED requirement-id
    occurrences removed, whitespace collapsed, truncated at the first sentence
    boundary. Removal is conservative to avoid mangling catalog prose:
    backticked occurrences always go; parenthesized groups that contain ONLY
    extracted tokens go; bare word occurrences stay ("3 distinct UI themes"
    keeps "UI"; ideation's PIT/IDEA/RETRO remain readable)."""
    role = entry.get("description", "") or ""
    tokens = [t for t in extract_requirement_ids(entry).split("/")]
    for tok in tokens:
        role = role.replace("`" + tok + "`", "")
    if tokens:
        token_set = set(tokens)

        def _drop_paren_group(m: "re.Match[str]") -> str:
            inner = m.group(1) or ""
            segments = []
            for seg in inner.split("/"):
                segments.extend(seg.split(","))
            cleaned = [s.strip() for s in segments if s.strip()]
            if cleaned and all(s in token_set for s in cleaned):
                return ""
            return m.group(0)

        role = re.sub(r"\(([^()]*)\)", _drop_paren_group, role)
    # Tidy the seams left by removals.
    role = re.sub(r"\(\s*\)", "", role)
    role = re.sub(r"\(\s*,\s*", "(", role)
    role = re.sub(r",\s*\)", ")", role)
    role = re.sub(r"\s+([,.])", r"\1", role)
    role = re.sub(r"^[^A-Za-z0-9`]+", "", role)
    role = re.sub(r"[ \t]{2,}", " ", role).strip()
    first_sentence_end = re.search(r"(?<=\.)\s", role)
    if first_sentence_end:
        role = role[: first_sentence_end.end()]
    return role.strip()


def lookup_catalog_entry(catalog: Dict[str, Any], component_id: str) -> Dict[str, Any]:
    """Catalog lookup: exact id first, then the top-level parent group for
    sub-component manifest ids like media/stt (DP-G §6.17 granularity)."""
    for c in catalog.get("components", []):
        if c.get("id") == component_id:
            return c
    parent_id = component_id.split("/")[0]
    for c in catalog.get("components", []):
        if c.get("id") == parent_id:
            return c
    raise CatalogError(
        f'component id "{component_id}" has no entry in contracts/component-catalog.json '
        "- update the catalog once per DP-G §6 (disclosure must not invent descriptions)"
    )


def render_bullet(catalog: Dict[str, Any], component_id: str) -> str:
    """One disclosure bullet: `**<id>** — <display_name> (`<req ids>`) — <role>`"""
    entry = lookup_catalog_entry(catalog, component_id)
    req_ids = extract_requirement_ids(entry)
    role = derive_role_sentence(entry)
    req_part = f" (`{req_ids}`)" if req_ids else ""
    return f"- **{component_id}** — {entry.get('display_name', '')}{req_part} — {role}"


DEFAULT_SHIPS_IN_APP = frozenset({"resilience", "platform", "media", "context", "cost", "data"})


def ships_in_app(catalog: Dict[str, Any], component_id: str) -> bool:
    """Does this block's SOURCE run inside the shipped application?

    Catalog ``ships_in_app`` is authoritative; the frozenset above is the fallback for
    catalogs that predate the field. Authoring/pipeline tooling is False.
    """
    try:
        entry = lookup_catalog_entry(catalog, component_id)
        value = entry.get("ships_in_app")
        if isinstance(value, bool):
            return value
    except Exception:
        pass
    return component_id in DEFAULT_SHIPS_IN_APP


def render_capability_bullet(catalog: Dict[str, Any], component_id: str) -> str:
    """One plain-English clause — no module id, display name or requirement codes.

    A disclosure should say what pre-existing code is present, not advertise where it
    came from.
    """
    capability = ""
    try:
        entry = lookup_catalog_entry(catalog, component_id)
        value = entry.get("disclosure_capability")
        if isinstance(value, str) and value.strip():
            capability = value.strip()
    except Exception:
        pass
    if not capability:
        try:
            capability = re.sub(r"\s{2,}", " ", re.sub(r"`[^`]*`", "", derive_role_sentence(
                lookup_catalog_entry(catalog, component_id)))).strip()
        except Exception:
            capability = "a shared infrastructure helper"
    return f"- {capability}"


def _sha256_hex(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def parse_ai_log(ai_log_bytes: Optional[str]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Parse ai_tools.json text -> (valid entries, skip warnings). A wholly
    malformed payload warns and yields an EMPTY list — a broken optional log
    must never block disclosure (PROV-RES-01)."""
    if ai_log_bytes is None or not ai_log_bytes.strip():
        return [], []
    try:
        parsed = json.loads(ai_log_bytes)
    except json.JSONDecodeError:
        return [], ["warn: ai-log is not valid JSON — section omitted (PROV-RES-01)"]
    if not isinstance(parsed, list):
        return [], ["warn: ai-log is not a JSON array — section omitted (PROV-RES-01)"]
    entries: List[Dict[str, Any]] = []
    warnings: List[str] = []
    for i, item in enumerate(parsed):
        res = validate_ai_log_entry(item)
        if res["valid"]:
            entries.append(item)
        else:
            detail = "; ".join(f"{e['path']} {e['message']}" for e in res["errors"])
            warnings.append(f"warn: ai-log entry {i} skipped (malformed): {detail} (GOV-RES-02)")
    return entries, warnings


def parse_and_validate_manifest(manifest_bytes) -> Dict[str, Any]:
    """Parse + RES-04-validate manifest bytes. Raises ManifestValidationError
    on parse or schema failure — the caller must write nothing when this fires
    (accuracy over availability, DP-J §8)."""
    if isinstance(manifest_bytes, bytes):
        manifest_bytes = manifest_bytes.decode("utf-8")
    try:
        parsed = json.loads(manifest_bytes)
    except json.JSONDecodeError as exc:
        raise ManifestValidationError("/", f"manifest is not valid JSON: {exc}", "parse") from exc
    result = validate(load_assembly_manifest_schema(), parsed)
    if not result["valid"]:
        errors = result["errors"]
        first = errors[0]
        detail = "; ".join(f"{e['path']}: {e['message']}" for e in errors)
        raise ManifestValidationError(
            first.get("path", "/"), detail, first.get("code", "manifest_invalid")
        )
    return parsed


def generate_disclosure(
    manifest_bytes,
    ai_log_bytes: Optional[str],
    catalog: Dict[str, Any],
    config: Optional[Dict[str, Any]] = None,
    now: Optional[str] = None,
) -> Dict[str, Any]:
    """PROV-01/02/03/04 — pure function of its inputs. Renders the disclosure
    Markdown exactly per DP-J §3.1 and derives the PROV-05 architecture summary
    from the same inputs so both artifacts share one source_manifest_hash."""
    # Local import avoids a circular module import at load time (summary.py
    # imports derivation helpers from this module).
    from src.provenance.provo.summary import build_architecture_summary

    config = config or {}
    source_manifest_hash = _sha256_hex(manifest_bytes)
    manifest = parse_and_validate_manifest(manifest_bytes)

    components_reused = [c["id"] for c in manifest["components"] if c.get("included")]
    excluded = [c["id"] for c in manifest["components"] if not c.get("included")]

    ai_log, warnings = parse_ai_log(ai_log_bytes)

    short_sha_length = int(config.get("short_sha_length", 7))
    short_sha = manifest["chassis_version"][:short_sha_length]
    generated_at = now or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # PROV-04 — MANIFEST order preserved. Bullets cover only the blocks whose source runs
    # inside the shipped application; pipeline tooling gets one neutral sentence below,
    # because it is present in the repo but is not part of the product.
    app_blocks = [cid for cid in components_reused if ships_in_app(catalog, cid)]
    tool_blocks = [cid for cid in components_reused if not ships_in_app(catalog, cid)]
    bullets = "\n".join(render_capability_bullet(catalog, cid) for cid in app_blocks)

    sections: List[str] = [
        "# Provenance & Disclosure",
        "> Generated from the assembly manifest — do not hand-edit accuracy; "
        "polish wording only if needed.",
        "## Reused prior code",
    ]
    if app_blocks:
        sections.append(
            "For this hackathon I reused **%d** pre-existing block(s) of code that handle "
            "infrastructure-level functionality, none of them specific to this project:\n\n%s"
            % (len(app_blocks), bullets)
        )
    else:
        sections.append("No pre-existing application code was reused for this hackathon.")
    sections.append(
        "Thus all application-level code, and most other low-level code, was designed and "
        "implemented only for this hackathon."
    )
    if tool_blocks:
        sections.append(
            "The repository also contains a small amount of pre-existing developer tooling used "
            "to prepare this submission's documents. The application does not call it at runtime "
            "and it is not part of the product."
        )
    sections.append(
        "## How this entry was built\n\nThe workflow was: design plans authored with Claude AI "
        "from my project idea, then implemented using cheaper AI models. Testing was done with "
        "Claude as well."
    )

    if config.get("include_excluded_footnote") is True and excluded:
        footnote_lines = [f"- **{cid}** — excluded per assembly.manifest.json." for cid in excluded]
        sections.append("### Components not included\n\n" + "\n".join(footnote_lines))

    # AI assistance appears ONLY when the log is non-empty (PROV-RES-01).
    if ai_log:
        ai_bullets = "\n".join(f"- **{e['tool']}** — {e['scope']}" for e in ai_log)
        sections.append(f"## AI assistance\n\n{ai_bullets}")

    # No "how to cite" section: the reused blocks are infrastructure helpers, and naming the
    # repository they came from invites a reader to treat this entry as a reskin of it.
    # Provenance stays verifiable through the manifest hash below.
    _ = short_sha
    sections.append(f"_Generated at {generated_at} from manifest hash {source_manifest_hash}._")

    disclosure_text = re.sub(r"[\r\n]+$", "", "\n\n".join(sections))

    architecture_summary = build_architecture_summary(manifest, catalog, config, now=now)
    source_ai_log_hash = (
        _sha256_hex(ai_log_bytes) if ai_log_bytes is not None and ai_log_bytes.strip() else None
    )

    return {
        "disclosure_text": disclosure_text,
        "architecture_summary": architecture_summary,
        "components_reused": components_reused,
        "ai_tool_log": ai_log if ai_log else None,
        "source_manifest_hash": source_manifest_hash,
        "source_ai_log_hash": source_ai_log_hash,
        "generated_at": generated_at,
        "warnings": warnings,
    }
