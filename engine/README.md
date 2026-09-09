# TODO(ENGINE): replace these stubs with your Engine — start at docs/engine-guide.md

# Engine

This directory is YOURS. It holds the parts the hackathon judges experience:
agent entry points (`agents/`), prompts (`prompts/`), I/O schemas (`schema/`),
retrieval corpus (`rag/`), and voice policy (`voice/`). Every file arrived as a
`TODO(ENGINE)` stub — replace them per `docs/engine-guide.md`. Agent calls are
pre-wrapped by the resilience layer (RES-01), so your first working version is
already demo-proof against timeouts/provider hiccups.

## What the chassis is NOT

The chassis deliberately ships NO domain answers: no personas, no pre-written
prompts, no corpus content, no fixed agent graph, no voice policy decisions.
Those are your hour-1 design work (NONGOAL-01..04). Assembling again with more
components never overwrites edits you make here (ASM-05 preservation).
