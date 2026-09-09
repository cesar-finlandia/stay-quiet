// Requirement IDs: DATA-03
// Permanent synthetic marker injection — DP-H §5.2. The marker is injected BY
// CODE after validation succeeds, never requested from the model, so a model
// omitting it cannot cause a violation. Records get `synthetic: true`; documents
// additionally get the header text PREPENDED INSIDE `content` (stripping-
// resistant) plus the `watermark_header` metadata field.

import type { SyntheticDocument, SyntheticRecord } from "./types.js";

/** Which watermark convention to apply (DP-H §5.2 table). */
export type WatermarkKind = "records" | "documents";

/** Default header text — mirrors defaults.json / contracts (single wording). */
export const WATERMARK_HEADER_TEXT = "SYNTHETIC DEMO DATA — NOT REAL";

/**
 * Injects the permanent marker into every element IN PLACE and returns the
 * batch typed as watermarked. Purely structural — never throws on odd shapes;
 * non-object elements are passed through untouched (validation happens before
 * this point).
 */
export function watermarkBatch(
  batch: unknown[],
  kind: WatermarkKind,
  headerText: string = WATERMARK_HEADER_TEXT,
): Array<SyntheticRecord | SyntheticDocument> {
  for (const element of batch) {
    if (typeof element !== "object" || element === null || Array.isArray(element)) continue;
    const obj = element as Record<string, unknown>;
    obj["synthetic"] = true as const; // DATA-03 — const true, machine-checkable
    if (kind === "documents") {
      // Header lives INSIDE content (stripping-resistant) + metadata field.
      // Idempotent: an already-marked element (e.g. served from the RES-05
      // golden cache) keeps its single header — never double-prepended.
      const content = typeof obj["content"] === "string" ? (obj["content"] as string) : "";
      if (!content.startsWith(headerText)) obj["content"] = `${headerText}\n\n${content}`;
      obj["watermark_header"] = headerText;
      if (typeof obj["doc_type"] !== "string") obj["doc_type"] = "general";
      if (obj["title"] === undefined) obj["title"] = null;
      if (obj["metadata"] === undefined) obj["metadata"] = null;
    }
  }
  return batch as Array<SyntheticRecord | SyntheticDocument>;
}
