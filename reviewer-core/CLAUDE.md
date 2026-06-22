# reviewer-core/ — pure review engine

## Stack
- TypeScript only — no framework, no I/O, no DB
- Zod for structured output + validation
- OpenAI SDK (used through provider-agnostic wrappers)

## Commands (run from `reviewer-core/`)
- `npm test`            — vitest (`--passWithNoTests`)
- `npm run typecheck`   — `tsc --noEmit`

## Where things live (map only)
- `src/review/`       pipeline — `run.ts` (orchestrate), `reduce.ts` (dedup/score)
- `src/llm/`          LLM client — `openrouter.ts`, `structured.ts`
- `src/output/`       Zod schemas for findings
- `src/prompt.ts`     prompt assembly
- `src/grounding.ts`  citation gate — drops findings citing non-existent diff lines
- `src/index.ts`      public surface

## Non-default conventions
- **Pure functions only.** No `fs`, no `fetch`, no `process.env` reads inside this package. Inject dependencies; don't import them.
- Consumed by `server/` via tsconfig path alias (`@devdigest/reviewer-core` → `../reviewer-core/src`). **Not** an installed dependency.
- Every public function takes structured input and returns structured output (Zod-validated where it crosses the boundary).

## Gotchas
- Changing `output/` schemas is a breaking change for `server/` callers. Update both in the same PR.
- `grounding.ts` runs after the LLM call. If the LLM produces a finding whose line ref doesn't exist in the diff, it's dropped silently — that's intentional.
- Token counting / pricing lives in `server/platform/` (price book), not here. This package stays provider-agnostic.

## Do-not-touch zones
- `src/grounding.ts` — the citation gate. Never weaken it without a written spec in `specs/`.

## More
- [README.md](README.md)
- [docs/](docs/), [specs/](specs/), [INSIGHTS.md](INSIGHTS.md)
- Root: [../CLAUDE.md](../CLAUDE.md)
