// Requirement IDs: DECKGEN-03, DECKGEN-REU-02, GOV-MIN-04, GOV-RES-04, XCUT-08
// Manifest → Mermaid `graph TD` architecture diagram — DP-D2a §3.4.
// Pure, deterministic, RES-01-free (no LLM anywhere): the output is a pure
// function of (manifest bytes, catalog bytes). Nodes = manifest components with
// included:true (top-level granularity only — never exploded into catalog
// sub-components); labels are fetched from contracts/component-catalog.json at
// runtime, never hardcoded (DECKGEN-REU-02: generic to any manifest shape).
// Edges derive deterministically from catalog `depends_on` hints filtered to
// included ids, plus one dotted EventEnvelope annotation edge when a transport-
// side node is present. Mermaid is emitted as plain text — zero new runtime dep
// (GOV-MIN-04); Marp renders it natively (DP-D1 §3.5).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validate } from "../../resilience/index.js";

/** Frozen contract source (#6 DAG hints) — loaded once, never copied. */
let cachedManifestSchema: object | null = null;
function loadManifestSchema(): object {
  if (!cachedManifestSchema) {
    const url = new URL("../../../contracts/assembly-manifest.schema.json", import.meta.url);
    cachedManifestSchema = JSON.parse(readFileSync(url, "utf8")) as object;
  }
  return cachedManifestSchema;
}

/** Structural views of the two input bytes (manifest per #6, catalog per DP-G §6). */
export interface ManifestComponent {
  id: string;
  included: boolean;
  [k: string]: unknown;
}
export interface AssemblyManifest {
  manifest_version: string;
  created_at: string;
  chassis_version: string;
  components: ManifestComponent[];
  [k: string]: unknown;
}
export interface CatalogComponent {
  id: string;
  description?: string;
  depends_on?: string[];
  sub_components?: string[];
  [k: string]: unknown;
}
export interface ComponentCatalog {
  version?: string;
  components: CatalogComponent[];
}

/**
 * Mermaid node ids accept word characters only; uppercase + underscore keeps
 * them stable, collision-free, and visually distinct from edge syntax.
 * `platform/deploy` → `PLATFORM_DEPLOY`, `dev-tooling` → `DEV_TOOLING`.
 */
export function sanitizeId(id: string): string {
  const cleaned = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(cleaned) ? `N_${cleaned}` : cleaned || "NODE";
}

/** Labels are quoted (descriptions may contain mermaid-hostile chars); only `"` needs escaping. */
function label(id: string, description: string): string {
  return `${id}["${id}<br/>${description.replace(/"/g, "#quot;")}"]`;
}

/** DECKGEN signal: manifest rejected pre-write — caller/CLI maps to exit 1 (§6.6). */
export class ManifestValidationError extends Error {
  readonly errors: Array<{ path: string; message: string; code: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string; code: string }>) {
    super(message);
    this.name = "ManifestValidationError";
    this.errors = errors;
  }
}

/**
 * generateDiagram — DP-D2a §3.4 algorithm, verbatim:
 *   1. RES-04 validate manifest against contracts/assembly-manifest.schema.json
 *      (invalid → ManifestValidationError; CLI maps to exit 1).
 *   2. One node per included top-level id; label `${id}<br/>${catalog description}`.
 *   3. Solid edges from catalog depends_on filtered to included ids
 *      (`dep --> id`); one dotted envelope annotation edge when a transport-side
 *      node and an envelope producer/consumer co-exist. No hand-placed arrows.
 *   4. `graph TD` + classDef chassis (PIT-02 tokens) + Legend subgraph carrying
 *      manifest_version / chassis_version / generated date from the manifest.
 */
export function generateDiagram(manifest: unknown, catalog: ComponentCatalog): string {
  const result = validate(loadManifestSchema(), manifest);
  if (!result.valid || typeof manifest !== "object" || manifest === null) {
    throw new ManifestValidationError(
      "assembly.manifest.json failed RES-04 validation against contracts/assembly-manifest.schema.json",
      result.errors,
    );
  }
  const m = manifest as AssemblyManifest;

  // Catalog lookup (single source DP-G §6) — missing entry is a hard error so a
  // stale catalog can never silently render an unlabeled node.
  const byId = new Map(catalog.components.map((c) => [c.id, c]));
  const included = m.components.filter((c) => c.included);
  const includedIds = new Set(included.map((c) => c.id));
  for (const c of included) {
    if (!byId.has(c.id)) {
      throw new Error(
        `component-catalog.json has no entry for included component "${c.id}" — update the catalog (DP-G §6 single source)`,
      );
    }
  }

  // Nodes — top-level granularity only; sub_components are never exploded.
  const lines: string[] = [];
  const nodeIds: string[] = [];
  for (const c of included) {
    const entry = byId.get(c.id) as CatalogComponent;
    const nid = sanitizeId(c.id);
    nodeIds.push(nid);
    lines.push(`  ${label(nid, entry.description ?? c.id)}`);
  }

  // Edges — deterministic from catalog hints, both endpoints must be included.
  for (const c of included) {
    const deps = byId.get(c.id)?.depends_on ?? [];
    for (const dep of deps) {
      if (includedIds.has(dep) && dep !== c.id) {
        lines.push(`  ${sanitizeId(dep)} --> ${sanitizeId(c.id)}`);
      }
    }
  }

  // Envelope annotation edge — transport side present + a resilience/context/ui
  // counterpart (§3.4 condition, evaluated on whatever granularity the manifest
  // uses). Source preference resilience > context > platform/ui; skipped when
  // only the transport node itself qualifies.
  const transportNode =
    (includedIds.has("platform/transport") && "platform/transport") ||
    (includedIds.has("platform") && "platform") || null;
  if (transportNode) {
    const source = ["resilience", "context", "platform/ui"].find(
      (id) => includedIds.has(id) && id !== transportNode,
    );
    if (source) {
      lines.push(`  ${sanitizeId(source)} -.->|EventEnvelope TRN-01| ${sanitizeId(transportNode)}`);
    }
  }

  // Styling reuses PIT-02 tokens; class list covers exactly the emitted nodes.
  const header = "graph TD";
  const classDef = "  classDef chassis fill:#6AE3FF,stroke:#F2F2F2,color:#0F1115;";
  const classLine = `  class ${nodeIds.join(",")} chassis`;

  // Legend — every value read from the manifest itself (pure input, no clock).
  const generated = String(m.created_at ?? "").slice(0, 10);
  const legend = [
    "  subgraph Legend",
    "    direction LR",
    `    L1["Manifest ${m.manifest_version}<br/>chassis ${String(m.chassis_version).slice(0, 7)}<br/>generated ${generated}"]`,
    "  end",
  ];

  return [header, ...lines, "", classDef, classLine, "", ...legend].join("\n") + "\n";
}

/**
 * writeDiagram — atomic tmp+rename emit of diagram.mmd (GOV-RES-04, mirrors
 * src/resilience/cache/store.ts / src/data/writer.ts). Parent dirs created.
 */
export function writeDiagram(outPath: string, text: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, outPath);
}
