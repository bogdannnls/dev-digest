# server/ — Fastify API + orchestrator

## Stack
- Fastify 5, Drizzle ORM, Postgres 16 + pgvector
- Adapters injected via `src/platform/container.ts` (DI)
- Octokit (GitHub), simple-git, @ast-grep/napi, dependency-cruiser, ripgrep

## Commands (run from `server/`)
- `pnpm dev`            — `tsx watch src/server.ts`
- `pnpm build`          — `tsc`
- `pnpm test`           — vitest (all suites)
- `pnpm typecheck`      — `tsc --noEmit`
- `pnpm db:generate`    — drizzle-kit generate
- `pnpm db:migrate`     — apply pending migrations
- `pnpm db:seed`        — seed demo data

Unit only: `pnpm exec vitest run --exclude '**/*.it.test.ts'`
Integration only: `pnpm exec vitest run .it.test` (needs Docker)

## Where things live (map, not file-by-file)
- `src/modules/`   business logic — `repos`, `pulls`, `agents`, `reviews`, `repo-intel`, `settings`, `polling`, `workspace`
- `src/adapters/`  external boundaries — `llm`, `github`, `git`, `secrets`, `astgrep`, `depgraph`, `codeindex`, `embedder`, `tokenizer`, `auth`
- `src/platform/`  cross-cutting infra — DI container, errors, grounding, prompts, SSE, model router, price book, resilience
- `src/db/`        Drizzle schema + migrations
- `test/helpers/`  shared test fixtures (`pg.ts` for integration DB)

## Non-default conventions
- Routes register Zod schemas at the boundary; invalid requests return 422 automatically.
- Every external call goes through an adapter. No raw `fetch` / `octokit` in `modules/`.
- Errors must extend types from `platform/errors.ts`. No `throw new Error()` in route handlers.
- Integration tests: filename ends in `*.it.test.ts` and imports from `test/helpers/pg.ts`. CI splits on this suffix.

## Gotchas
- LLM provider is read from settings per request, not at boot. Don't cache it across requests.
- `repo-intel` indexing is lazy — assume the index may be stale or missing for any repo.
- SSE writes go through `platform/sse.ts`. Don't touch `reply.raw` directly.
- `adapters/mocks.ts` is for tests only — never import from production code.

## Do-not-touch zones
- `src/db/migrations/*.sql` — append-only.
- `src/platform/grounding.ts` — the citation gate. Weakening it lets hallucinated line refs through.

## More
- [README.md](README.md)
- [docs/](docs/) — deep dives (deeper than CLAUDE.md should go)
- [specs/](specs/) — feature/RFC specs
- [INSIGHTS.md](INSIGHTS.md) — server-specific learnings
- Root: [../CLAUDE.md](../CLAUDE.md), [../TESTING.md](../TESTING.md)
