# Requirement IDs: SUBMIT-01, SUBMIT-RES-01, GOV-REU-03, XCUT-08
"""SUBMIT-01 mechanical field extractor — Python twin of
src/provenance/submit/extract.ts (DP-J §5.1). No LLM anywhere: every value is
verbatim-copied from winning_project_plan.md (frontmatter or frozen body
headings) and assembly.manifest.json, never invented (SUBMIT-REU-01).

Field mapping table (DP-J §5.1):
  tagline      <- frontmatter.title | first sentence of `## Executive Pitch`
                  truncated to 120 chars
  target_user  <- frontmatter.persona | Business Value `- specific_user:` |
                  `## Target Persona` first line (verbatim)
  why_ai       <- `## Why Now` one-liner | Business Value `- why_ai:` |
                  first sentence of Why Now body
  tech_stack   <- deduped case-insensitive union of manifest
                  requires_providers (included components) plus explicit
                  comma-separated tags in `## Architecture` /
                  `## Suggested Module Emphasis`; original casing preserved,
                  sorted alphabetically for determinism.

Any canonical field with no source lands in not_extracted_fields and renders
the exact gap marker (SUBMIT-RES-01) — never blank, never fabricated."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from src.provenance.provo.validate import REPO_ROOT

WINNING_PLAN_FRONTMATTER_SCHEMA_PATH = (
    REPO_ROOT / "contracts" / "winning-plan-frontmatter.schema.json"
)

# SUBMIT-RES-01 exact gap marker (DP-J §5.5).
GAP_MARKER = "> — not stated in winning_project_plan.md — confirm manually"

# Frozen body headings (master_blueprint §4 #7 / DP-K §7).
FROZEN_HEADINGS: Tuple[str, ...] = (
    "Executive Pitch",
    "Problem Framing",
    "AI Solution",
    "Why Now",
    "Target Persona",
    "Business Value",
    "Architecture",
    "Suggested Module Emphasis",
)

TAGLINE_MAX_CHARS = 120


def split_frontmatter(plan_text: str) -> Tuple[Optional[str], str]:
    """Split a winning_project_plan.md document into (raw YAML|None, body).
    Frontmatter is only recognized when the very first line is `---` and a
    closing `---` line follows; otherwise the whole text is body."""
    lines = plan_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, plan_text
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "\n".join(lines[1:idx]), "\n".join(lines[idx + 1 :])
    return None, plan_text


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        inner = value[1:-1]
        # Undo the two escapes YAML double-quote style supports that matter
        # for plan files: \\" and \\\\ (keep everything else verbatim).
        if value[0] == '"':
            inner = inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner
    return value


def parse_simple_yaml(raw: str) -> Dict[str, Any]:
    """Minimal YAML subset parser for the frozen frontmatter keys — plain
    `key: value` scalars (optionally quoted) plus inline `[a, b]` arrays.
    Comments and blank lines are skipped. Unknown keys are kept so RES-04 can
    flag them via additionalProperties:false."""
    result: Dict[str, Any] = {}
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", stripped)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if value.startswith("[") and value.endswith("]"):
            items = [item.strip() for item in value[1:-1].split(",")]
            result[key] = [_unquote(item) for item in items if item]
        else:
            result[key] = _unquote(value)
    return result


def split_sections(body: str) -> Dict[str, str]:
    """Split the body by frozen heading regex `^##\\s+<heading>\\s*$`.
    Returns heading -> section text (everything up to the next `## ` heading;
    leading/trailing blank lines trimmed). Unfrozen headings are ignored."""
    sections: Dict[str, str] = {}
    current: Optional[str] = None
    buffer: List[str] = []
    heading_re = re.compile(r"^##\s+(.+?)\s*$")
    for line in body.splitlines():
        match = heading_re.match(line)
        if match:
            if current is not None:
                sections[current] = "\n".join(buffer).strip()
            name = match.group(1)
            current = name if name in FROZEN_HEADINGS else None
            buffer = []
        elif current is not None:
            buffer.append(line)
    if current is not None:
        sections[current] = "\n".join(buffer).strip()
    return sections


def first_sentence(text: str, max_chars: int = TAGLINE_MAX_CHARS) -> str:
    """First sentence of `text` truncated to max_chars (DP-J §5.1 tagline
    fallback). Sentence boundary = `.`, `!` or `?` followed by whitespace."""
    collapsed = re.sub(r"\s+", " ", text).strip()
    if not collapsed:
        return ""
    match = re.match(r"^(.+?[.!?])(?:\s|$)", collapsed)
    sentence = match.group(1) if match else collapsed
    return sentence[:max_chars]


_TAG_ITEM_RE = re.compile(r"^[A-Z][A-Za-z0-9.+#]*(?: [A-Z][A-Za-z0-9.+#]*)?$")
_TAG_LINE_PREFIX_RE = re.compile(
    r"(?:^|[\s;*])(?:stack|tech stack|tags|built with)\s*:\s*([^\n]+)$",
    re.IGNORECASE,
)


def extract_tech_tags(section_text: str) -> List[str]:
    """Extract explicit comma-separated stack tags from one section's text
    (DP-J §5.1: "comma-separated tags like `React`, `OpenAI`, `Vercel`").
    Mechanical, reproducible rule — a line yields tags when either
      (a) it contains a `Stack:` / `Tech stack:` / `Tags:` / `Built with:`
          marker (line start or mid-sentence after whitespace/`;`) and
          every comma-separated item after it matches _TAG_ITEM_RE, or
      (b) the WHOLE line is a run of >= 2 comma-separated _TAG_ITEM_RE
          tokens.
    Prose sentences never qualify under (b), so nothing is invented."""
    tags: List[str] = []
    for line in section_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        prefixed = _TAG_LINE_PREFIX_RE.search(stripped)
        candidate = prefixed.group(1).strip() if prefixed else stripped
        if not prefixed and ":" in candidate.split(",")[0].split(" ")[0]:
            continue  # some other `key: ...` line — never treat as tag run
        items = [item.strip().rstrip(".") for item in candidate.split(",")]
        if len(items) < 2:
            continue
        if all(item and _TAG_ITEM_RE.match(item) and len(item) <= 30 for item in items):
            tags.extend(items)
    return tags


def _bullet_value(section_text: str, key: str) -> str:
    """Value of a `- key: value` bullet inside a section body, else \"\"."""
    for line in section_text.splitlines():
        match = re.match(r"^\s*[-*]\s*" + re.escape(key) + r"\s*:\s*(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return ""


def _first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def extract_fields(
    plan_text: str,
    manifest_providers: List[str],
    tech_tag_sections: Optional[Dict[str, str]] = None,
    provider_labels: Optional[Dict[str, str]] = None,
    frontmatter: Optional[Dict[str, Any]] = None,
    frontmatter_valid: bool = False,
) -> Dict[str, Any]:
    """Map canonical fields per DP-J §5.1. Pure: no FS, no LLM, no clock.

    plan_text          — full winning_project_plan.md text
    manifest_providers — requires_providers of included components
    tech_tag_sections  — optional {section name -> text} scanned for explicit
                         tags; None (default) scans the plan's own
                         `## Architecture` / `## Suggested Module Emphasis`
    provider_labels    — optional config/submit.json:provider_labels map
                         (e.g. openai -> OpenAI), display-only
    frontmatter        — RES-04-validated frontmatter dict (None/ignored
                         when invalid or absent → body fallback)
    frontmatter_valid  — False when RES-04 rejected the frontmatter

    Returns {tagline, target_user, why_ai, tech_stack, not_extracted_fields,
             sections, warnings} — gapped fields carry empty values and are
    listed in not_extracted_fields in canonical order (SUBMIT-RES-01)."""
    warnings: List[str] = []
    raw_frontmatter, body = split_frontmatter(plan_text)
    sections = split_sections(body)

    title = str(frontmatter.get("title", "")).strip() if (frontmatter and frontmatter_valid) else ""
    persona = str(frontmatter.get("persona", "")).strip() if (frontmatter and frontmatter_valid) else ""

    # --- tagline: frontmatter.title | Executive Pitch first sentence ------
    tagline = title or first_sentence(sections.get("Executive Pitch", ""))

    # --- target_user: persona | Business Value.specific_user | Target Persona
    target_user = (
        persona
        or _bullet_value(sections.get("Business Value", ""), "specific_user")
        or _first_nonempty_line(sections.get("Target Persona", ""))
    )

    # --- why_ai: Why Now one-liner | Business Value.why_ai | first sentence
    why_now = sections.get("Why Now", "")
    why_ai = (
        _first_nonempty_line(why_now)
        or _bullet_value(sections.get("Business Value", ""), "why_ai")
        or (first_sentence(why_now, max_chars=400) if why_now else "")
    )

    # --- tech_stack: union(manifest providers, explicit section tags) -----
    tag_sources = (
        tech_tag_sections
        if tech_tag_sections is not None
        else {name: sections.get(name, "") for name in ("Architecture", "Suggested Module Emphasis")}
    )
    labels = provider_labels or {}
    seen: Dict[str, str] = {}  # lowercase -> original casing (display)
    for provider in manifest_providers:
        name = str(provider).strip()
        if not name:
            continue
        seen.setdefault(name.lower(), labels.get(name.lower(), name))
    for section_name in ("Architecture", "Suggested Module Emphasis"):
        for tag in extract_tech_tags(tag_sources.get(section_name, "")):
            seen.setdefault(tag.lower(), labels.get(tag.lower(), tag))
    tech_stack = sorted(seen.values())

    fields: Dict[str, Any] = {
        "tagline": tagline.strip(),
        "target_user": target_user.strip(),
        "why_ai": why_ai.strip(),
        "tech_stack": tech_stack,
    }
    fields["not_extracted_fields"] = [
        name
        for name in ("tagline", "target_user", "why_ai", "tech_stack")
        if not fields[name]
    ]
    fields["sections"] = sections
    fields["warnings"] = warnings
    return fields
