"""Provenance & Disclosure Toolkit — SUBMIT (Platform Submission Copy
Formatter), DP-J §5. Public surface mirrors src/provenance/provo/__init__."""

from src.provenance.submit.embed import DISCLOSURE_GAP_PLACEHOLDER, embed_disclosure
from src.provenance.submit.extract import GAP_MARKER, extract_fields
from src.provenance.submit.format import DEFAULT_CONFIG, format_submission, load_submit_config
from src.provenance.submit.labels import CANONICAL_FIELDS, resolve_labels

__all__ = [
    "CANONICAL_FIELDS",
    "DEFAULT_CONFIG",
    "DISCLOSURE_GAP_PLACEHOLDER",
    "GAP_MARKER",
    "embed_disclosure",
    "extract_fields",
    "format_submission",
    "load_submit_config",
    "resolve_labels",
]
