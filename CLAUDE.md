# DevDigest — project guide for Claude

## What this is
Local-first, AI-powered PR review studio. See [README.md](README.md) for the elevator pitch and quick start.

## Packages (4, no monorepo workspace)
- `server/`         Fastify API + Postgres + orchestration
- `client/`         Next.js 15 UI
- `reviewer-core/`  Pure review engine (no I/O)
- `e2e/`            agent-browser flows (deterministic, no LLM)

Each package has its own `CLAUDE.md` — read it before working there.

## Stack with versions
- Node ≥22, pnpm ≥10, Docker (Postgres pgvector only)
- TypeScript everywhere
- Cross-package imports via tsconfig path aliases — **not** a workspace; no root lockfile

## Top-level commands
- `./scripts/dev.sh`   — full local stack (Postgres + server + client)
- `./scripts/e2e.sh`   — hermetic e2e
- Per-package commands live in each package's `CLAUDE.md`

## Non-default conventions
- Integration tests must use the `*.it.test.ts` suffix (CI splits on this).
- Secrets live in `~/.devdigest/secrets.json` (mode `0600`), with `process.env` fallback. Never in DB. Never committed.
- Database migrations are **not** auto-applied on boot — run `pnpm db:migrate` manually.
- Each package has its own `package.json` and lockfile. Don't add a root one.

## Gotchas
- `reviewer-core` is consumed by `server` via tsconfig path alias, not as an installed dependency. Don't add it to `dependencies`.
- pgvector extension is required; bare Postgres won't apply migration `0000`.
- LLM provider is selected from settings at request time, not at boot.

## Do-not-touch zones
- `server/src/db/migrations/*.sql` — append-only; never edit applied migrations.
- `e2e/specs/*.flow.json` — change only with intentional UX update + review.
- `skills-lock.json` — managed by tooling.
- `.github/workflows/*` — change only with explicit intent; CI is path-filtered per package.

## Where to look
- Test philosophy + suite map: [TESTING.md](TESTING.md)
- Deep dives: [docs/](docs/)
- Cross-package RFCs / specs: [specs/](specs/)
- Cross-cutting learnings: [INSIGHTS.md](INSIGHTS.md)
