// Requirement IDs: DATA-AC-02, DATA-02, DATA-05
// Acceptance — DP-H §9.2 verbatim: a document batch is ingested by a shape-only
// dummy RAG stub with NO reformatting (docs fed exactly as generateDocuments
// returned them). Isolation principle (blueprint §9): mocked ProviderCall only.
// Domain nouns appear here because the test mirrors the examples/ fixtures.
import { describe, expect, it } from "vitest";
import { generateDocuments } from "../generate.js";
import { setProviderCall } from "../provider.js";

interface IngestDoc {
  synthetic: boolean;
  doc_type: string;
  content: string;
  title?: string | null;
}

/** Dummy RAG stub — shape-only, no embeddings/ranking (DP-H §9.2). */
function dummyRagIngest(docs: IngestDoc[]): { ingested: number; ids: string[] } {
  for (const d of docs) {
    if (d.synthetic !== true) throw new Error("missing synthetic marker");
    if (typeof d.content !== "string" || d.content.length < 20) throw new Error("content too short");
  }
  return { ingested: docs.length, ids: docs.map((_, i) => `doc-${i}`) };
}

describe("DATA-AC-02 — document batch ingested by dummy RAG stub with no reformatting", () => {
  it("policy/faq documents ingest unchanged and stay watermarked", async () => {
    const mockDocs = [
      {
        doc_type: "policy",
        title: "Acme Corp Widget Return Policy",
        content:
          "SYNTHETIC DEMO DATA\n\nAcme Corp widget returns accepted within 14 days.\nLorem ipsum synthetic paragraph.",
        metadata: { source: "synthetic" },
      },
      {
        doc_type: "faq",
        title: "Widget Onboarding FAQ",
        content: "SYNTHETIC DEMO DATA\n\nQ: How to onboard Acme Corp widgets?\nA: Connect via widget console.\nLorem ipsum.",
        metadata: null,
      },
    ];
    setProviderCall(async () => JSON.stringify(mockDocs));

    const result = await generateDocuments(
      {
        domain: "Acme Corp widget knowledge base — return policies, onboarding, troubleshooting — for RAG rehearsal",
        shape: { kind: "documents", doc_type: "general", count: 2 },
      },
      { writeFile: false }, // temp-dir discipline
    );
    expect((result as { degraded?: unknown }).degraded).toBeUndefined();
    const docs = (result as { batch: IngestDoc[] }).batch;

    // No reformatting — feed docs exactly as returned
    const ingest = dummyRagIngest(docs);
    expect(ingest.ingested).toBe(2);

    // Watermark assertions
    expect(docs.every((d) => d.synthetic === true)).toBe(true);
    expect(docs.every((d) => d.content.includes("SYNTHETIC DEMO DATA"))).toBe(true);
  });

  it("transcript doc_type batch ingested unchanged", async () => {
    const transcript = [
      {
        doc_type: "transcript",
        title: null,
        content:
          "Agent: Welcome to Acme Corp widget support.\nUser: My widget preview is slow.\nAgent: Let me check...",
        metadata: { speakers: ["Agent", "User"] },
      },
    ];
    setProviderCall(async () => JSON.stringify(transcript));
    const r = await generateDocuments(
      {
        domain: "Acme Corp synthetic support call transcripts for rehearsal",
        shape: { kind: "documents", doc_type: "transcript", count: 1 },
      },
      { writeFile: false },
    );
    expect(dummyRagIngest((r as { batch: IngestDoc[] }).batch).ingested).toBe(1);
  });
});
