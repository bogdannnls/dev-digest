# PR architecture skills + self-review workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two instruction skills (`ui-architecture`, `onion-architecture`) plus a dispatcher workflow (`pr-self-review`) that runs a second-pass architectural review of the uncommitted diff before Claude claims a task ready.

**Architecture:** Two SKILL.md files codify the rules (MUST/SHOULD severity). A workflow script under `.claude/workflows/pr-self-review.js` detects which surfaces changed in the diff, dispatches parallel review subagents loaded with the relevant skills, and returns structured findings. A one-line CLAUDE.md addition makes Claude soft-invoke the workflow before claiming "ready"; a slash-command wrapper lets the user invoke it manually.

**Tech Stack:** Markdown skills (project-local under `.claude/skills/`), JavaScript Workflow scripts (under `.claude/workflows/`), the Claude Code Workflow runtime (`agent()`, `parallel()`, `pipeline()`, structured `schema` returns).

**Spec:** [docs/superpowers/specs/2026-06-23-pr-architecture-skills-design.md](../specs/2026-06-23-pr-architecture-skills-design.md)

## Global Constraints

- All artifacts and commit messages in English (per global CLAUDE.md).
- Commit messages use the existing repo style — lower-case `type(scope): message`, single quotes, no trailing period. Example: `docs(claude): add ui-architecture skill`.
- Severity vocabulary in the two new skills is **MUST / SHOULD** — deliberate divergence from the `CRITICAL/HIGH/MEDIUM` used in `react-best-practices`. MUST = blocker (workflow blocks "ready"); SHOULD = advisory (workflow lists, does not block).
- No restructuring of `client/`, `server/`, `modules/`, `adapters/`, or `platform/`. Skills codify the existing structure; they do not move code.
- Each task ends with one `git add` of its named files + one commit. No commits skip pre-commit hooks. No `--no-verify`. No force-push, no push to remote.
- The Workflow runtime forbids `Date.now()`, `Math.random()`, and argless `new Date()` in workflow scripts. Do not use them.

## File structure (final)

```
.claude/
├── skills/
│   ├── ui-architecture/
│   │   └── SKILL.md                                  # Task 2 creates
│   ├── onion-architecture/
│   │   └── SKILL.md                                  # Task 3 creates
│   └── ... (existing skills, untouched)
├── workflows/
│   └── pr-self-review.js                             # Task 4 creates
└── commands/
    └── pr-self-review.md                             # Task 5 creates
CLAUDE.md                                             # Task 6 modifies (+1 line)
docs/superpowers/notes/
└── 2026-06-23-subagent-skill-access-probe.md         # Task 1 creates (probe finding)
```

Task 1 is a spike — its only artifact is a one-page notes file recording whether workflow subagents can load skills. The outcome dictates Task 4's structure (skill-loading vs inline-rule fallback).

---

## Task 1: Spike — verify workflow subagents can load Skills

**Why first:** the spec flagged this as an open item. The outcome determines whether Task 4's subagent prompts say "invoke the `ui-architecture` skill" or instead inline the rule list. Cheap to run; expensive to defer.

**Files:**
- Create: `docs/superpowers/notes/2026-06-23-subagent-skill-access-probe.md`
- Test: n/a (spike — the probe IS the test)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded yes/no answer that Task 4 reads.

- [ ] **Step 1: Pick an existing skill to probe with**

Use `react-best-practices` — it already exists at `.claude/skills/react-best-practices/SKILL.md` and has a stable first line we can echo back.

- [ ] **Step 2: Run a one-shot Workflow probe**

Invoke the Workflow tool with this inline script (do NOT save it as a named workflow — it's throwaway):

```js
export const meta = {
  name: 'subagent-skill-probe',
  description: 'One-shot probe: can a workflow subagent invoke the Skill tool?',
  phases: [{ title: 'Probe' }],
}

phase('Probe')
const result = await agent(
  "Use the Skill tool with skill='react-best-practices'. " +
  "Then return ONLY the literal first heading line of the loaded skill content " +
  "(should start with '# '). If the Skill tool errored, return the error text " +
  "prefixed with 'ERROR: '.",
  {
    schema: {
      type: 'object',
      properties: { firstLine: { type: 'string' } },
      required: ['firstLine'],
      additionalProperties: false,
    },
  }
)
return result
```

Expected outcomes:
- **Success path:** returned object has `firstLine` starting with `# ` — workflow subagents CAN invoke Skill. Task 4 uses skill loading.
- **Failure path:** `firstLine` starts with `ERROR: ` (or the call throws) — workflow subagents CANNOT invoke Skill. Task 4 inlines rule lists into the subagent prompts.

- [ ] **Step 3: Record the result**

Create `docs/superpowers/notes/2026-06-23-subagent-skill-access-probe.md` with this exact body, filling in the verdict:

~~~markdown
# Subagent Skill access probe — 2026-06-23

## Probe
One-shot workflow that spawned a subagent and asked it to invoke
`Skill(skill='react-best-practices')` and return the first heading line.

## Result
- Verdict: <SUCCESS | FAILURE>
- Returned firstLine: `<paste the exact returned string>`

## Consequence for Task 4
- If SUCCESS: subagent prompts will read "Invoke the <name> skill before reviewing".
- If FAILURE: subagent prompts will inline the MUST/SHOULD rule list from the SKILL.md verbatim, plus the Detection hints block.
~~~

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-06-23-subagent-skill-access-probe.md
git commit -m 'docs(notes): record subagent skill-access probe finding'
```

---

## Task 2: UI-architecture instruction skill

**Files:**
- Create: `.claude/skills/ui-architecture/SKILL.md`
- Test: see Step 5 (manual review against a planted violation)

**Interfaces:**
- Consumes: nothing.
- Produces: the skill loaded under the name `ui-architecture`. Detection hints (last section) are read by the pr-self-review workflow subagent in Task 4.

- [ ] **Step 1: Create the skill file with the full body**

Create `.claude/skills/ui-architecture/SKILL.md` with this exact content:

~~~markdown
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
~~~

- [ ] **Step 2: Plant a violation file (test)**

Create a throwaway file at `client/src/components/__violation__.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'

export function Violation() {
  const [data, setData] = useState<unknown>(null)
  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(setData)
  }, [])
  return <pre>{JSON.stringify(data)}</pre>
}
```

This file violates MUST.1 (raw `fetch`) and MUST.2 (component fetches directly).

- [ ] **Step 3: Manually verify the skill catches both violations**

In a fresh session, ask Claude:

> "Invoke the ui-architecture skill, then review `client/src/components/__violation__.tsx`. List every rule violated with rule id + line."

Expected: Claude reports at minimum MUST.1 and MUST.2 with `client/src/components/__violation__.tsx` and the relevant line numbers.

- [ ] **Step 4: Delete the violation file**

```bash
rm client/src/components/__violation__.tsx
```

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/ui-architecture/SKILL.md
git commit -m 'feat(claude): add ui-architecture instruction skill'
```

---

## Task 3: Onion-architecture instruction skill

**Files:**
- Create: `.claude/skills/onion-architecture/SKILL.md`
- Test: see Step 5 (manual review against a planted violation)

**Interfaces:**
- Consumes: nothing.
- Produces: the skill loaded under the name `onion-architecture`. Detection hints read by the pr-self-review subagent.

- [ ] **Step 1: Create the skill file with the full body**

Create `.claude/skills/onion-architecture/SKILL.md` with this exact content:

~~~markdown
---
name: onion-architecture
description: "DevDigest server/ Onion architecture rules. Use when editing or reviewing files under server/src/ — routes, modules, adapters, platform. Enforces inward-pointing dependencies and the boundary between business logic and external integrations."
---

# Onion Architecture (server/)

The server is layered: **routes** (Fastify handlers) → **modules** (services + domain) → injected via the `platform/container.ts` DI container. **Adapters** sit at the edge (LLM, GitHub, git, secrets, indexers). Dependencies point inward.

Companion to `server/CLAUDE.md`; this is the enforceable form.

## Severity

- **MUST** — blocker. The `pr-self-review` workflow flags MUST violations as blockers; Claude must address before claiming work ready.
- **SHOULD** — advisory. Listed in the final review summary; does not block.

---

## Rules

### MUST.1 — No adapter import in route handlers
Why: Routes are an HTTP-shaped delivery surface. Business logic and external boundaries belong in services; adapters reach the service through the container.
Red flag: a file under `server/src/` that registers Fastify routes (`fastify.get`, `fastify.post`, etc.) importing from `server/src/adapters/`.

### MUST.2 — No raw `fetch` / `octokit` / `simple-git` / `fs` / network calls in `modules/`
Why: Every external boundary has exactly one adapter; modules consume the adapter interface, never the underlying library.
Red flag: under `server/src/modules/`, an import of `octokit`, `simple-git`, `node:fs`, `node:fs/promises`, or a call to global `fetch(`.

### MUST.3 — No `throw new Error()` in routes or modules
Why: Errors must extend a typed class from `platform/errors.ts` so the boundary can map to HTTP status and structured logs.
Red flag: `throw new Error(` under `server/src/modules/` or in any Fastify route handler.

### MUST.4 — No cross-module imports between `modules/X` ↔ `modules/Y`
Why: Modules are bounded contexts. Shared domain helpers live in `modules/_shared/`; cross-module orchestration goes through a port wired by the container.
Red flag: a file at `server/src/modules/X/...` importing from `server/src/modules/Y/...` for any `X ≠ Y` and `Y ≠ _shared`.

### MUST.5 — No adapter-to-adapter imports
Why: Adapters are leaves. If A needs B, the shared concern is platform-level or the orchestration is a module's job.
Red flag: a file at `server/src/adapters/A/...` importing from `server/src/adapters/B/...` for any `A ≠ B`.

### MUST.6 — All routes register Zod schemas at the request boundary
Why: Invalid input is rejected at the seam (422), never propagates inward.
Red flag: a Fastify route declared without a `schema:` or `attachValidation`-equivalent on its body/query/params.

### SHOULD.7 — DI wiring lives in `platform/container.ts`
Why: Boot-time construction of adapters in exactly one place; test substitution stays sane.
Rule: no `new XAdapter()` outside `platform/container.ts`.
Red flag: `new SomethingAdapter(` outside `platform/container.ts`.

### SHOULD.8 — `adapters/mocks.ts` is test-only
Why: Production code that reaches into a mock is a latent bug.
Red flag: import of `server/src/adapters/mocks` from a non-test file (i.e., not `*.test.ts` or `*.it.test.ts`).

### SHOULD.9 — Settings-driven state read per request, never cached at boot
Why: LLM provider is selected per request from settings. Boot-time capture freezes the wrong value.
Red flag: a module-level `const llm = container.llm()` or equivalent in module/service code.

### SHOULD.10 — Integration tests: `*.it.test.ts` + `test/helpers/pg.ts`
Why: CI splits on the `.it.test.ts` suffix; the helper provides a real Postgres for assertions.
Red flag: a test file whose name does not end in `.it.test.ts` but imports `testcontainers` or `pg.ts`; or one that ends in `.it.test.ts` but does not import the helper.

---

## Principles & rationale

- **Dependencies point inward.** Routes depend on modules; modules depend on the container interface; adapters depend on nothing inside the app. Drawing an arrow outward is a smell.
- **One adapter per external concern.** `octokit` is wrapped exactly once; nothing else mentions it. The same goes for `simple-git`, `fs`, the LLM client.
- **Errors are typed.** A raw `throw new Error('...')` is information loss at the boundary; even a one-line subclass of a `platform/errors.ts` base is cheap and preserves the contract.
- **The container is the seam.** Tests substitute via the container; nothing else.

---

## Detection hints (consumed by `pr-self-review`)

| Rule     | Hint |
|----------|------|
| MUST.1   | List files registering Fastify routes: `grep -rlE '\bfastify\.(get\|post\|put\|patch\|delete)\(' server/src`. For each, `grep -nE "from ['\"].*\badapters/" $file` → any hit is a violation. |
| MUST.2   | `grep -rE "from ['\"](octokit\|simple-git\|node:fs(/promises)?)\b" server/src/modules` and `grep -rE '\bfetch\(' server/src/modules`. Any hit is a violation. |
| MUST.3   | `grep -rnE '\bthrow new Error\(' server/src/modules` plus the same over Fastify route files identified for MUST.1. Any hit is a violation. |
| MUST.4   | For every pair of module folders `(X, Y)` under `server/src/modules/`, `grep -rE "from ['\"].*\bmodules/${X}/" server/src/modules/${Y}/` for `X ≠ Y ≠ _shared`. Any hit is a violation. |
| MUST.5   | For every pair of adapter folders `(A, B)` under `server/src/adapters/`, `grep -rE "from ['\"].*\badapters/${A}/" server/src/adapters/${B}/` for `A ≠ B`. Any hit is a violation. |
| MUST.6   | For each route declaration found in MUST.1, manual review: does the declaration include a `schema:` property covering body/query/params it reads? |
| SHOULD.7 | `grep -rnE '\bnew \w+Adapter\(' server/src` → any hit outside `server/src/platform/container.ts` is an advisory. |
| SHOULD.8 | `grep -rE "from ['\"].*\badapters/mocks" server/src` → any hit in a non-test file is an advisory. |
| SHOULD.9 | Manual review: a module-level `const x = container.<service>()` outside a function/handler body. |
| SHOULD.10| `find server/src -name '*.test.ts' -not -name '*.it.test.ts' | xargs grep -lE "(testcontainers\|test/helpers/pg)"` → any hit is an advisory. |

---

## When to invoke

Use this skill when editing or reviewing any file under `server/src/`. The `pr-self-review` workflow loads it for the server-side review pass.
~~~

- [ ] **Step 2: Plant a violation file (test)**

Create a throwaway file at `server/src/modules/repos/__violation__.ts`:

```ts
import { Octokit } from 'octokit'

export async function fetchRepoBad(token: string, owner: string, name: string) {
  const octo = new Octokit({ auth: token })
  const res = await octo.rest.repos.get({ owner, repo: name })
  if (!res.data) throw new Error('not found')
  return res.data
}
```

This violates MUST.2 (raw `octokit` in modules) and MUST.3 (`throw new Error` in a module).

- [ ] **Step 3: Manually verify the skill catches both violations**

Ask Claude in a fresh session:

> "Invoke the onion-architecture skill, then review `server/src/modules/repos/__violation__.ts`. List every rule violated with rule id + line."

Expected: at minimum MUST.2 and MUST.3 reported on the right lines.

- [ ] **Step 4: Delete the violation file**

```bash
rm server/src/modules/repos/__violation__.ts
```

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/onion-architecture/SKILL.md
git commit -m 'feat(claude): add onion-architecture instruction skill'
```

---

## Task 4: pr-self-review workflow script

**Depends on:** Task 1 (verdict on skill access), Task 2, Task 3.

**Files:**
- Create: `.claude/workflows/pr-self-review.js`
- Test: see Step 4 (workflow runs and returns expected shape on a no-op diff)

**Interfaces:**
- Consumes: the two new skills by name (if Task 1 returned SUCCESS) or by inlined rules (if FAILURE).
- Produces: a workflow invocable via `Workflow({ name: 'pr-self-review' })` returning `{ must: Finding[], should: Finding[], partial: boolean, skipped: boolean }` where `Finding = { severity, rule, file, line, excerpt, why, fix_hint }`.

- [ ] **Step 1: Decide the agent prompt shape from Task 1's result**

Open `docs/superpowers/notes/2026-06-23-subagent-skill-access-probe.md`. If verdict is SUCCESS, the agent prompts will load skills by name (variant A). If FAILURE, the prompts will inline the rule list (variant B). The script body below shows both — keep the matching branch and delete the other before saving.

- [ ] **Step 2: Create the workflow script**

Create `.claude/workflows/pr-self-review.js` with this exact content:

```js
export const meta = {
  name: 'pr-self-review',
  description:
    'Second-pass architectural review of uncommitted diff before claiming a task ready. ' +
    'Detects whether client/ and/or server/ changed, dispatches parallel review agents loaded ' +
    'with the architecture skills + matching framework skills, returns structured findings.',
  phases: [
    { title: 'Detect surfaces' },
    { title: 'Review' },
    { title: 'Synthesize' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'rule', 'file', 'line', 'excerpt', 'why', 'fix_hint'],
        properties: {
          severity: { type: 'string', enum: ['MUST', 'SHOULD'] },
          rule: { type: 'string' },           // e.g. 'ui-arch.MUST.4'
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          excerpt: { type: 'string' },
          why: { type: 'string' },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
}

phase('Detect surfaces')

// One agent does the file discovery — it can shell out to git via Bash.
// We don't have shell access from the workflow body itself.
const surfaces = await agent(
  "Run these two commands and union their outputs, then report which surfaces changed:\n" +
    "  1) git diff --name-only HEAD\n" +
    "  2) git ls-files --others --exclude-standard\n" +
    "Treat each line as a path. Set touchesClient=true if any path starts with 'client/'. " +
    "Set touchesServer=true if any path starts with 'server/'. Return both flags plus the " +
    "deduplicated list of paths.",
  {
    label: 'detect-surfaces',
    phase: 'Detect surfaces',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['touchesClient', 'touchesServer', 'paths'],
      properties: {
        touchesClient: { type: 'boolean' },
        touchesServer: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
      },
    },
  }
)

if (!surfaces || (!surfaces.touchesClient && !surfaces.touchesServer)) {
  return { must: [], should: [], partial: false, skipped: true }
}

phase('Review')

// --- VARIANT A (use if Task 1 verdict = SUCCESS): skill loading ---
const clientPrompt =
  "Invoke these skills first: ui-architecture, react-best-practices, react-testing-library. " +
  "Then read every changed file under client/ (paths listed below). For each MUST/SHOULD rule, " +
  "apply the Detection hints from the ui-architecture skill. Report every violation as a finding " +
  "with severity, rule id (e.g. 'ui-arch.MUST.4'), file, line, excerpt, why, fix_hint. " +
  "If no violations, return an empty findings array.\n\nChanged paths:\n" +
  surfaces.paths.filter(p => p.startsWith('client/')).join('\n')

const serverPrompt =
  "Invoke these skills first: onion-architecture, fastify-best-practices, drizzle-orm-patterns. " +
  "Then read every changed file under server/ (paths listed below). For each MUST/SHOULD rule, " +
  "apply the Detection hints from the onion-architecture skill. Report every violation as a finding " +
  "with severity, rule id (e.g. 'onion.MUST.1'), file, line, excerpt, why, fix_hint. " +
  "If no violations, return an empty findings array.\n\nChanged paths:\n" +
  surfaces.paths.filter(p => p.startsWith('server/')).join('\n')

// --- VARIANT B (use if Task 1 verdict = FAILURE): inline rules ---
//   Replace the two prompts above with prompts that paste the MUST/SHOULD rule list
//   and Detection hints from .claude/skills/<name>/SKILL.md verbatim, then say
//   "review the changed paths against these rules."

const reviews = await parallel(
  [
    surfaces.touchesClient
      ? () => agent(clientPrompt, { label: 'review:client', phase: 'Review', schema: FINDINGS_SCHEMA })
      : null,
    surfaces.touchesServer
      ? () => agent(serverPrompt, { label: 'review:server', phase: 'Review', schema: FINDINGS_SCHEMA })
      : null,
  ].filter(Boolean)
)

phase('Synthesize')

const expected = (surfaces.touchesClient ? 1 : 0) + (surfaces.touchesServer ? 1 : 0)
const succeeded = reviews.filter(Boolean)
const partial = succeeded.length < expected

const all = succeeded.flatMap(r => r.findings)
return {
  must: all.filter(f => f.severity === 'MUST'),
  should: all.filter(f => f.severity === 'SHOULD'),
  partial,
  skipped: false,
}
```

- [ ] **Step 3: Validate the script parses**

Run from the repo root:

```bash
node --check .claude/workflows/pr-self-review.js
```

Expected: no output (file parses). If a syntax error is reported, fix and re-run.

- [ ] **Step 4: Smoke-run with an empty diff**

From a clean working tree (no uncommitted changes, no untracked files in `client/` or `server/`), invoke the workflow:

```
Workflow({ name: 'pr-self-review' })
```

Expected return: `{ must: [], should: [], partial: false, skipped: true }`.

If `skipped` is not `true`, the Detect-surfaces agent is mis-classifying. Inspect its output and adjust the prompt.

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/pr-self-review.js
git commit -m 'feat(claude): add pr-self-review workflow'
```

---

## Task 5: Slash-command wrapper

**Depends on:** Task 4.

**Files:**
- Create: `.claude/commands/pr-self-review.md`

**Interfaces:**
- Consumes: the workflow `pr-self-review` registered in Task 4.
- Produces: a `/pr-self-review` slash command for manual user invocation.

- [ ] **Step 1: Create the slash command file**

Create `.claude/commands/pr-self-review.md` with this exact content:

~~~markdown
---
description: Run a second-pass architectural review of the uncommitted diff (client/ + server/) before claiming work ready.
---

Invoke the Workflow tool with `name: 'pr-self-review'`. After it returns:

1. If `skipped: true`, report "No changes in client/ or server/ — nothing to review." and stop.
2. If `partial: true`, name which side failed and stop without claiming pass/fail.
3. List `must` findings as blockers (each: rule id, file:line, why, fix_hint). For each MUST, propose a concrete fix and ask before applying — per the global "ask before risky actions" rule.
4. List `should` findings as advisories.
5. Final line: a one-sentence verdict — "READY" if `must` is empty and `partial` is false; "BLOCKED — N MUST findings" otherwise.
~~~

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/pr-self-review.md
git commit -m 'feat(claude): add /pr-self-review slash command'
```

---

## Task 6: Root CLAUDE.md soft-gate line

**Depends on:** Tasks 4 and 5 (so the rule references a working command).

**Files:**
- Modify: `CLAUDE.md` (root)

**Interfaces:**
- Consumes: nothing.
- Produces: a one-line rule that makes Claude auto-invoke the workflow before claiming ready.

- [ ] **Step 1: Read the current CLAUDE.md to find the right insertion point**

Open `CLAUDE.md`. The new rule belongs in a "Pre-ready checks" or similar near the bottom — alongside the existing engineering-insights guidance, before "Where to look".

- [ ] **Step 2: Insert the rule**

Add a new section directly above the "Where to look" section:

~~~markdown
## Pre-ready architectural check

Before marking work ready, if the diff touches `client/` or `server/`, run `/pr-self-review`. Treat MUST findings as blockers (propose a fix, ask before applying). SHOULD findings are advisory — include them in the final summary. If the workflow reports `partial: true`, do not claim ready until it can run cleanly.
~~~

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m 'docs(claude): add pre-ready architectural check rule'
```

---

## Task 7: End-to-end smoke test on a worktree

**Depends on:** Tasks 2, 3, 4, 5, 6.

**Files:**
- Create (then delete): two violation files inside a throwaway worktree.
- Modify: `INSIGHTS.md` (root) — append one entry recording the smoke result.

**Interfaces:**
- Consumes: the full chain (skills + workflow + slash command + CLAUDE.md rule).
- Produces: an INSIGHTS entry confirming the soft gate works end-to-end.

- [ ] **Step 1: Create an isolated worktree**

From the repo root:

```bash
git worktree add ../dev-digest-smoke-pr-self-review HEAD
cd ../dev-digest-smoke-pr-self-review
```

- [ ] **Step 2: Plant one violation per side**

Client violation (`client/src/components/__smoke__.tsx`):

```tsx
'use client'
import { useEffect, useState } from 'react'

export function Smoke() {
  const [d, setD] = useState<unknown>(null)
  useEffect(() => { fetch('/api/agents').then(r => r.json()).then(setD) }, [])
  return <pre>{JSON.stringify(d)}</pre>
}
```

Server violation (`server/src/modules/repos/__smoke__.ts`):

```ts
import { Octokit } from 'octokit'

export async function smokeBad(token: string) {
  const o = new Octokit({ auth: token })
  const r = await o.rest.repos.listForAuthenticatedUser()
  if (!r.data) throw new Error('empty')
  return r.data
}
```

- [ ] **Step 3: Run the slash command**

In a Claude Code session pointed at the worktree:

```
/pr-self-review
```

Expected: a BLOCKED verdict with at least these MUST findings:
- `ui-arch.MUST.1` on `client/src/components/__smoke__.tsx`
- `ui-arch.MUST.2` on the same file
- `onion.MUST.2` on `server/src/modules/repos/__smoke__.ts`
- `onion.MUST.3` on the same file

- [ ] **Step 4: Record the result in INSIGHTS.md**

In the **main worktree** (not the smoke worktree), append the entry:

~~~markdown
## 2026-06-23 — pr-self-review soft gate works end-to-end
Context: building the pre-ready architectural check.
What we tried: planted one MUST violation per surface in a worktree, ran `/pr-self-review`.
What worked: workflow detected both surfaces, dispatched parallel review agents, returned `must` findings on the right files/lines; slash command reported BLOCKED.
Why it matters: confirms the soft gate is wired correctly. The next risk is drift — Claude skipping the gate. Revisit if drift is observed.
~~~

- [ ] **Step 5: Remove the smoke worktree**

```bash
cd <main worktree>
git worktree remove ../dev-digest-smoke-pr-self-review --force
```

- [ ] **Step 6: Commit the INSIGHTS update from the main worktree**

```bash
git add INSIGHTS.md
git commit -m 'docs(insights): record pr-self-review end-to-end smoke result'
```

---

## Self-review

Run through the spec once with fresh eyes:

- **Coverage:**
  - Q1 tighten → Task 2 + Task 3 add the new `[new]` and `[tighten]` rules. ✓
  - Q2 hybrid+severity → both SKILL.md files use MUST/SHOULD + Principles + Detection hints. ✓
  - Q3 soft auto-gate → Task 6 adds the CLAUDE.md line. Task 5 makes the manual path work. ✓
  - Q4 findings → propose fixes → Task 5's slash command instructs Claude to propose fixes and ask before applying. ✓
  - Spec open item "workflow agent skill loading — unverified" → Task 1 (spike). ✓
  - Spec open item "CLAUDE.md wording" → Task 6 spells it out. ✓
  - Spec open item "short-circuit on tiny diffs" → deliberately not implemented (spec default: no threshold). ✓
- **Placeholder scan:** no TBD/TODO; every step has executable code or commands. The one branch in Task 4 (variant A vs B) is conditional on Task 1's recorded verdict, not a placeholder.
- **Type consistency:** `Finding` shape is identical across Task 4's schema, Task 5's slash command body, and the spec.
- **Naming consistency:** rule ids `ui-arch.MUST.N` / `onion.MUST.N` are used uniformly across Task 4's prompts and Task 5's slash command instructions.

No issues found.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-06-23-pr-architecture-skills-and-self-review.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
