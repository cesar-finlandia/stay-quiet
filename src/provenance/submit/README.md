# submit — Platform Submission Copy Formatter + Repo Hygiene Guard (M11)

DP-J §5–§8 · requirement IDs SUBMIT-01..05 · Python/TypeScript twins in this
directory (`*.py` / `*.ts`, byte-compatible outputs modulo `generated_at`).

## Commands

```bash
# submission copy (SUBMIT-01..04); also runs the hygiene guard as its advisory section
submit format --plan winning_project_plan.md --manifest assembly.manifest.json \
              [--disclosure disclosure.md] [--event-profile event_profile.json] \
              [--config config/submit.json] [--out submission.md]

# standalone hygiene run (SUBMIT-05) — writes <out>.json + <out>.md
submit hygiene --manifest assembly.manifest.json [--include-unstaged] \
               [--config config/hygiene.json] [--out hygiene-report]
```

## Hygiene guard — flag-only, read-only (NONGOAL-16)

The scanner performs **only** reads + regex tests + glob matches. It never
writes, deletes, or rewrites history — no `git filter-branch`, no `git reset`,
no `git rm`. When it flags a secret:

1. `git rm --cached <file>` (keep the working copy),
2. add the path to `.gitignore`,
3. **rotate/revoke the exposed key** — removal from git does not un-leak it,
4. commit the fix, then re-run `submit hygiene`.

Exit codes: `0` = clean or degraded (`unavailable` — e.g. not a Git repo yet,
ASM-06 precondition; formatting is never blocked, SUBMIT-RES-03); `1` =
explicitly `flagged` — the operator decides to block; reports/submission are
still written before exit.

Configuration lives in `config/hygiene.json` (schema:
`contracts/hygiene-config.schema.json`; defaults hardcoded in
`hygiene.py`/`hygiene.ts`). Every secret pattern, credential filename glob,
ignore path, and the commit-distribution bucket/threshold (`1h` / `0.8`)
are config-only changes.
