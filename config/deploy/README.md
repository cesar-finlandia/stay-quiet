# Deploy configuration — read this first

Requirement IDs: DEP-01, DEP-02, DEP-03, DEP-04, DEP-REU-01, DEP-RES-01,
DEP-RES-02 | DP-B §5.1–§5.6, §8.

This directory is the **single source of provider truth** (`DEP-REU-01`).
Application code (`src/platform/*`, `src/resilience/*`, `engine/*`) never
imports a provider SDK — provider details live only here and in
`src/platform/deploy/adapters/`.

## Files

| File | Purpose |
|---|---|
| `provider.json` | Default `DEPLOY_PROVIDER` (`"vercel"`), overridable by env |
| `vercel.json` | Vercel project settings; assembly (ASM-02) copies it verbatim |
| `replit.json` | Replit descriptor (adapter wires `.replit` from it) |
| `streamlit.toml` | Streamlit Cloud descriptor (Python-only; no native SSE → set `TRANSPORT=none`) |
| `docker.json` | Docker/PaaS descriptor (registry from `DOCKER_REGISTRY` env) |

## Provider swap (config-only)

```bash
DEPLOY_PROVIDER=replit    npm run deploy   # uses config/deploy/replit.json
DEPLOY_PROVIDER=streamlit npm run deploy   # uses config/deploy/streamlit.toml
DEPLOY_PROVIDER=docker    npm run deploy   # builds Dockerfile, pushes per DOCKER_REGISTRY
npm run deploy                             # default: vercel --prod --confirm
```

## Required environment keys

Copy `config/env.example` → `.env` and fill:

- Runtime knobs: `DEPLOY_PROVIDER`, `TRANSPORT`, `THEME`, `API_BASE`
- Secrets (never committed, never defaulted): `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `TRACE_ID_SALT`
- Deploy credentials: `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`
  (only the keys for your chosen provider are required)
- Output of a deploy: `PUBLIC_URL` (consumed by the smoke script)

## Smoke command (DEP-04)

```bash
npm run deploy:verify   # scripts/smoke-deploy.ts — polls GET $PUBLIC_URL/health
                        # every 2 s up to 30 s; budget p50 ≤ 3 min, p95 ≤ 6 min
```

## Rollback command (DEP-03)

Full procedure: `docs/deployment.md` §Rollback. TL;DR:

```bash
git tag -a known-good -m "last smoke-passed deploy" && git push origin known-good
npx vercel rollback --project $VERCEL_PROJECT_ID --yes   # preferred, instant
git revert HEAD --no-edit && git push origin main        # provider-agnostic path
npm run deploy:verify                                    # assert /health after rollback
```

## Re-derivation after months (DEP-RES-02)

Cold clone → deployed URL in ≤ 10 min from this file + `docs/deployment.md` alone:

```bash
git clone <chassis> && cd chassis
cp config/env.example .env      # fill the keys listed above
npm ci && npm run deploy:verify # must pass within the DEP-04 budget
```

Last verified marker lives in `CHANGELOG.md` (`XCUT-04`); stale pins surface
via DOCTOR-03 before deploy, not mid-demo.
