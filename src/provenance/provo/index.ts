// Requirement IDs: PROV-01, PROV-05, GOV-REU-03, XCUT-06, XCUT-08
// Public barrel of the PROV Disclosure Generator (DP-J §9.2). Consumers import
// ONLY this module — never generate/summary internals directly. The rendered
// artifacts (disclosure.md / architecture-summary.md) remain the file-based
// integration boundary for DECKGEN-02 / SUBMIT-02 / FAQDEF-02 (contract #8):
// they read the FILES verbatim, never these functions.

export {
  generateDisclosure,
  parseAndValidateManifest,
  parseAiLog,
  renderBullet,
  deriveRoleSentence,
  lookupCatalogEntry,
  ManifestValidationError,
  CatalogError,
} from "./generate.js";
export type {
  AiToolLogEntry,
  AssemblyManifest,
  CatalogEntry,
  ComponentCatalog,
  DisclosureConfig,
  DisclosureResult,
  GenerateOptions,
  ManifestComponent,
} from "./generate.js";
export {
  buildArchitectureSummary,
  generateSummary,
  isSummaryTooShort,
} from "./summary.js";
export type { SummaryResult } from "./summary.js";
export {
  AI_LOG_ENTRY_SCHEMA,
  ASSEMBLY_MANIFEST_SCHEMA_PATH,
  CATALOG_PATH,
  DEFAULT_DISCLOSURE_CONFIG_PATH,
  DISCLOSURE_CONFIG_SCHEMA_PATH,
  REPO_ROOT,
  loadAssemblyManifestSchema,
  validateAiLogEntry,
  validateManifest,
} from "./validate.js";
export { runProvoCli } from "./cli.js";
