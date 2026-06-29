---
name: ui-architecture
description: "DevDigest client/ UI architecture rules. Use when editing or reviewing files under client/src/ — App Router pages, components, hooks, lib, tests. Codifies what goes where and which patterns are required vs advised."
---

# UI Architecture (client/)

Where things go and which patterns are required for the Next.js 15 App Router client. Companion to `client/CLAUDE.md`; this is the enforceable form.

## Severity

- **MUST** — blocker. The `pr-self-review` workflow flags MUST violations as blockers; Claude must address before claiming work ready.
- **SHOULD** — advisory. Listed in the final review summary; does not block.

---

## Rules

### MUST.1 — No raw `fetch` outside `client/src/lib/api.ts`
Why: All server access funnels through one entry point so auth, retries, error mapping, and tracing layer cleanly.
Red flag: `fetch(` anywhere under `client/src/` except `lib/api.ts`.

### MUST.2 — No data fetching in components or pages
Why: Server state lives in TanStack Query hooks under `client/src/lib/hooks/`. Components consume hooks; they do not fetch.
Red flag: a component or page calling `api.*` or `fetch` directly, or instantiating a `QueryClient`.

### MUST.3 — Server Components by default
Why: Next.js 15 RSC default is the cheapest path; `'use client'` is opt-in only when a file genuinely needs interactivity, hooks, or browser-only APIs.
Red flag: `'use client'` at the top of a file that does no hook/event/browser work.

### MUST.4 — No cross-page imports
Why: Route segments are independent surfaces. Shared code must be promoted, not borrowed sideways.
Red flag: a file under `client/src/app/<a>/` importing from `client/src/app/<b>/` (where `<a>` ≠ `<b>`). Promote to `client/src/components/` or `client/src/lib/`.

### SHOULD.5 — Page-only components colocated under `_components/`
Why: Files that change with one route should live with that route; only promote when reused.
Rule: a component used by exactly one route lives in `client/src/app/<route>/_components/` (Next.js private-folder convention, excluded from routing). Promote to `client/src/components/` on the second reuse (a second route imports it).
Red flag: a page-only component sitting directly in `client/src/components/`; or a route-private file in `app/<route>/` outside `_components/`.

### SHOULD.6 — Tests colocated next to the file under test
Why: One canonical location reduces friction; `__tests__/` siblings are a holdover.
Rule: `Foo.tsx` is tested by `Foo.test.tsx` in the same directory. Do not introduce `__tests__/` subdirectories.
Red flag: a new file under `__tests__/`.

### SHOULD.7 — File naming
Why: Tooling and grepability.
Rule: component files PascalCase (`DiffViewer.tsx`); non-component files kebab-case (`use-repos.ts`, `api.ts`). Next.js-reserved names (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`) follow the framework convention.
Red flag: `useRepos.ts` (camelCase) or `diff-viewer.tsx` (kebab for a component).

### SHOULD.8 — No imports from `src/vendor/` outside designated consumers
Why: Vendored code is leaf; if anything other than its designated consumer imports it, the seam has leaked.
Red flag: a new import of `client/src/vendor/...` from a file that did not previously import it.

---

## Principles & rationale

- **One way per concern.** API access through `lib/api.ts`; server state through TanStack Query hooks; UI state local. When a new concern appears, define one home for it before sprinkling it.
- **Routes are independent.** `app/agents/` and `app/repos/` may evolve separately; if they share, the shared thing is promoted, not coupled sideways.
- **Colocate, then promote.** A page-only component lives with its page until a second route needs it. Premature promotion (one-shot widgets in `src/components/`) creates a junk drawer.
- **RSC by default.** Adding `'use client'` is a load-cost decision; ask if the file really needs the client.

---

## Detection hints (consumed by `pr-self-review`)

The dispatcher subagent uses these to localise checks before reasoning. Patterns are POSIX `grep -rE` over the changed paths in the diff.

| Rule    | Hint |
|---------|------|
| MUST.1  | `grep -rE '\bfetch\(' client/src --include='*.ts' --include='*.tsx'` → any hit outside `client/src/lib/api.ts` is a violation. |
| MUST.2  | `grep -rE "from ['\"]@?.*\blib/api['\"]" client/src/app client/src/components` → any direct import of `api` outside `lib/hooks/` is a violation. |
| MUST.3  | `grep -nE "^'use client'" client/src/**/*.tsx` → for each hit, manual review: does the file use hooks/events/browser-only APIs? If not → violation. |
| MUST.4  | For each pair of route folders `(a, b)` under `client/src/app/`, `grep -rE "from ['\"].*\bapp/${a}/" client/src/app/${b}/`. Any hit is a violation. |
| SHOULD.5| Any new file under `client/src/components/` referenced by exactly one route → suggest move to `_components/`. Any non-`_components/` page-private file under `client/src/app/<route>/` → suggest move into `_components/`. |
| SHOULD.6| `find client/src -type d -name '__tests__'` → any hit is a violation in the diff. |
| SHOULD.7| Component files: `find client/src -name '*.tsx' -not -name '[A-Z]*'` minus Next-reserved names → violations. Non-component `.ts` files: `find client/src -name '*.ts' -name '*[A-Z]*'` → violations. |
| SHOULD.8| `grep -rE "from ['\"].*\bvendor/" client/src` → manual review of any new import. |

---

## When to invoke

Use this skill when editing or reviewing any file under `client/src/`. The `pr-self-review` workflow loads it for the client-side review pass.
