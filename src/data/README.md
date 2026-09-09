# src/data — Synthetic Demo-Data Generator

Requirement IDs: DATA-01…05, DATA-REU-01, DATA-RES-01, XCUT-06 · Plan: `design_documents/design_plans/DP-H-synthetic-demo-data-generator.md`

## Purpose

Generates synthetic demo data on demand from a runtime domain description + shape.
Two paths (DATA-02): structured records validated against a caller-supplied JSON
Schema, and schema-less documents for RAG-style rehearsal. Every element is
watermarked by code after validation (`synthetic: true`, DATA-03); output is
plain `Array<object>` JSON written atomically, with an optional RES-05 golden-cache
write-through of the same in-memory batch (DATA-05).

## Configuration

See DP-H §6 — edit `config/model-profiles.json` `roles["data-generator"]` to swap
provider/model (PGM-11: that shared file is the single routing source; this module
never keeps a second one). Data-specific knobs (`batch.maxCount`, watermark header
text, cache dir) live in `src/data/defaults.json`; caller config is deep-merged over
them and validated via RES-04 against `contracts/data-generator-config.schema.json`.
Missing/malformed config degrades to safe defaults with a warning — never a crash.

## Worked Example

```python
# Python mirror
from src.data import generate_records
result = await generate_records(domain="Acme Corp widget support tickets …", shape={"kind":"records", "schema": schema, "count": 5})
# result["batch"] each has synthetic:true
```

```typescript
// TypeScript (DP-H §4.3)
import { generateRecords } from "src/data";

const result = await generateRecords({
  domain: "Synthetic customer support tickets for Acme Corp …",
  shape: { kind: "records", schema: ticketSchema, count: 5 },
  watermark: true,
});
// result.batch each has synthetic:true — ready for MOCK-01 and the RES-05 cache
```

Both entry points never throw: failures surface as `DegradedResult`
(`DATA-RES-01`). Real event output lands in `<working-copy>/fixtures/synthetic/`
(gitignored), never in this repository's `examples/`.

**Disclaimer:** any data produced by this tool for a real event must stay out of
the chassis repository itself and belongs only in that event's submission repository.

## What This Does Not Contain

No domain corpus, no pre-generated dataset, no RAG embedding/ranking, no UI copy,
no Engine personas.
