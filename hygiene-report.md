# Hygiene report

### Secret scan — flagged (3 hit(s))

- `.env.example`:1 — pattern `credential_filename` — `.env...REDACTED`
- `node_modules/prettier/plugins/flow.js`:1 — pattern `aws_access_key` — `AKIA...REDACTED`
- `node_modules/prettier/plugins/flow.mjs`:1 — pattern `aws_access_key` — `AKIA...REDACTED`

Remediation is manual: `git rm --cached <file>`, add to `.gitignore`, rotate the key, then commit. This scanner is flag-only.

### Commit distribution — clean (67% in one 1h bucket)

3 total commits; largest bucket `2026-09-09T23:00Z` holds 2 (67%, threshold 80%).

## Warnings

- warn: hygiene config unreadable at src\provenance\config\hygiene.json: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\contracts\\hygiene-config.schema.json' — using safe defaults (GOV-RES-02)
- warn: cannot read docs/engine-guide.md: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\docs\\engine-guide.md'
- warn: cannot read engine/agents/index.ts: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\engine\\agents\\index.ts'
- warn: cannot read engine/agents/todo.agent.md: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\engine\\agents\\todo.agent.md'
- warn: cannot read engine/prompts/system.todo.md: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\engine\\prompts\\system.todo.md'
- warn: cannot read engine/prompts/user.todo.md: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\engine\\prompts\\user.todo.md'
- warn: cannot read engine/rag/corpus.todo.md: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\engine\\rag\\corpus.todo.md'
- warn: cannot read engine/voice/policy.todo.md: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\engine\\voice\\policy.todo.md'
- warn: cannot read models.json: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\models.json'
- warn: cannot read run_sweep.sh: [Errno 2] No such file or directory: 'C:\\Users\\cesar\\Documents\\CursorAI-projects\\hackathon-entries\\2026-09-agents_for_humans\\run_sweep.sh'

Overall: **flagged**

## Operator triage (2026-09-10, implementer note — not scanner output)

All three hits are false positives, verified by hand; nothing was removed:

- `.env.example:1` matches a filename pattern only. The file holds zero secrets: every
  credential field (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
  `AWS_ACCOUNT_ID`, `OPENAI_API_KEY`) is empty; the only non-empty values are
  non-secret defaults (region, model id, port). It is required by DP-FOUND (SQ-N-06)
  and `.env` itself is absent and git-ignored.
- The two `node_modules/prettier` hits are example keys inside a vendored toolchain
  package. `node_modules/` is git-ignored, never committed, never shipped (the
  Dockerfile's `.dockerignore` excludes it), and regenerable via `npm install`.

The remaining warnings are the manifest listing stubs this plan deleted on purpose
(`engine/rag/`, `engine/voice/`, TODO files, `models.json`, `run_sweep.sh`,
`docs/engine-guide.md`); the manifest is the assembly-time record and the tool only
warns. Re-run this scan before publishing; if any hit names a file under `src/`,
`engine/`, `config/`, `fixtures/synthetic/` or `fixtures/golden/`, treat it as real.
