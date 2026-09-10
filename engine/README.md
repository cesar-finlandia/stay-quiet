# engine/

The agent itself.

| Path | What is in it |
|---|---|
| `agents/stayquiet_agent.py` | the Strands agent loop, the deterministic triage gate, and `run_cycle()` |
| `tools/` | the six tools the loop may call. All deterministic: they read the synthetic fixtures, compute, emit a progress envelope, and return JSON. None of them calls a model |
| `prompts/` | the system prompt and the two task prompts, as plain Markdown |
| `schema/` | JSON Schemas for a cycle's input and output |
| `bridge/` | a small Node bridge to the conversation-buffer implementation, used to trim a long guest thread to a token budget |

The division of labour is deliberate: Python decides **which** bookings need work and **whether**
the host is interrupted; the model decides **how** to say it.
