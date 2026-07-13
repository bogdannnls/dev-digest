# client/ — Next.js 15 UI

## Stack
- Next.js 15 (App Router) + React 19
- Tailwind 4, TanStack Query, Lucide icons, react-markdown, Mermaid, Recharts
- vitest + jsdom + React Testing Library

## Commands (run from `client/`)
- `pnpm dev`        — `next dev -p 3000`
- `pnpm build`      — `next build`
- `pnpm test`       — vitest (jsdom)
- `pnpm typecheck`  — `tsc --noEmit`

## Where things live (map only)
- `src/app/`         Next.js App Router — `repos`, `agents`, `settings`, `onboarding`
- `src/components/`  reusable UI — diff viewer, mermaid, app shell, page shell
- `src/lib/`         API client, hooks, providers, theme, toast
- `src/i18n/`        translations
- `src/test/`        test setup
- `src/vendor/`      vendored third-party code

## Non-default conventions
- All server access goes through `src/lib/api.ts`. No raw `fetch` in components or pages.
- Server state is owned by TanStack Query hooks in `src/lib/hooks/`. Components don't fetch.
- Default to React Server Components; add `'use client'` only when you need it.
- Tests live next to the file under test or in `__tests__/` siblings.

## Gotchas
- Path aliases are configured in `tsconfig.json` — match the server's pattern.
- `vitest` runs against jsdom; `next dev` runs against Node. If a hook does Node-only work, mock it in tests.
- Mermaid renders client-side only — guard with `'use client'`.

## Do-not-touch zones
- `src/vendor/` — vendored code; update via tooling, not by hand.

## More
- [README.md](README.md)
- [docs/](docs/), [specs/](specs/) — SDD requirement specs authored by `spec-creator`, [INSIGHTS.md](INSIGHTS.md)
- Root: [../CLAUDE.md](../CLAUDE.md)
