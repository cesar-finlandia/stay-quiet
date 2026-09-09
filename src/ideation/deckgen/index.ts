// Requirement IDs: DECKGEN-01…06 — DP-D2a §8.2.
// Barrel for src/ideation/deckgen: re-exports the deck auto-populator surface.
export {
  generateDiagram,
  writeDiagram,
  sanitizeId,
  ManifestValidationError,
} from "./diagram.js";
export type {
  AssemblyManifest,
  ManifestComponent,
  ComponentCatalog,
  CatalogComponent,
} from "./diagram.js";
// DECKGEN-04 — Business Value → vector SVG charts + Mermaid pie alt (§3.5).
export {
  extractBusinessValueFigures,
  parseTamAmount,
  tamBarWidth,
  splitRevenueTags,
  generateTamChart,
  generateRevenueChart,
  generateRevenueMermaidAlt,
  writeChartAtomic,
  DEFAULT_CHART_PALETTE,
} from "./charts.js";
export type { BusinessValueFigures, ChartPalette } from "./charts.js";
// DECKGEN-01/02/05/06 — slot population engine (§3.1–§3.7).
export {
  populateDeck,
  parseWinningPlan,
  parsePlanFrontmatter,
  extractFrozenSection,
  extractBusinessValueFields,
  extractEvidenceLine,
  buildTitleSlot,
  buildProblemSlot,
  buildUserSlot,
  buildDemoSlot,
  buildArchitectureSlot,
  buildBusinessValueSlot,
  buildAskSlot,
  assembledUiScreenNames,
  renderSlotFile,
  renderDisclosureFile,
  extractDisclosureRegion,
  concatDeck,
} from "./populate.js";
export type { PopulateDeckInput, PopulateResult, ParsedPlan, BusinessValueFields as PlanBusinessValueFields } from "./populate.js";
// DECKGEN-RES-01 — RES-01-wrapped LLM bullet phrasing (optional, §6.1/§6.2).
export {
  DECKGEN_PHRASE_CONFIG,
  DECKGEN_PHRASER_ROLE,
  MODEL_PROFILES_PATH,
  PHRASE_PROMPT_PATH,
  getModelForRole,
  makeDeckgenPhraser,
  makeResilientDeckPhrase,
  parsePhraseResponse,
  phraseBullets,
  renderPhrasePrompt,
} from "./phrase.js";
export type {
  DeckLlmTransport,
  PhraseOptions,
  PhraseOutcome,
  PhraseSuccess,
  RoleModelRouting,
  SlotPhraser,
} from "./phrase.js";
