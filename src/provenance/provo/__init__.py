# Requirement IDs: PROV-01, PROV-05, GOV-REU-03, XCUT-06, XCUT-08
"""Public barrel of the PROV Disclosure Generator (DP-J §9.2). Consumers
import ONLY this package — never generate/summary internals directly. The
rendered artifacts (disclosure.md / architecture-summary.md) remain the
file-based integration boundary for DECKGEN-02 / SUBMIT-02 / FAQDEF-02
(contract #8): they read the FILES verbatim, never these functions."""

from src.provenance.provo.generate import (  # noqa: F401
    CatalogError,
    ManifestValidationError,
    derive_role_sentence,
    generate_disclosure,
    lookup_catalog_entry,
    parse_ai_log,
    parse_and_validate_manifest,
    render_bullet,
)
from src.provenance.provo.summary import (  # noqa: F401
    build_architecture_summary,
    generate_summary,
    is_summary_too_short,
)
from src.provenance.provo.validate import (  # noqa: F401
    AI_LOG_ENTRY_SCHEMA,
    ASSEMBLY_MANIFEST_SCHEMA_PATH,
    CATALOG_PATH,
    DEFAULT_DISCLOSURE_CONFIG_PATH,
    DISCLOSURE_CONFIG_SCHEMA_PATH,
    REPO_ROOT,
    load_assembly_manifest_schema,
    validate_ai_log_entry,
    validate_manifest,
)

__all__ = [
    "CatalogError",
    "ManifestValidationError",
    "AI_LOG_ENTRY_SCHEMA",
    "ASSEMBLY_MANIFEST_SCHEMA_PATH",
    "CATALOG_PATH",
    "DEFAULT_DISCLOSURE_CONFIG_PATH",
    "DISCLOSURE_CONFIG_SCHEMA_PATH",
    "REPO_ROOT",
    "build_architecture_summary",
    "derive_role_sentence",
    "generate_disclosure",
    "generate_summary",
    "is_summary_too_short",
    "load_assembly_manifest_schema",
    "lookup_catalog_entry",
    "parse_ai_log",
    "parse_and_validate_manifest",
    "render_bullet",
    "validate_ai_log_entry",
    "validate_manifest",
]
