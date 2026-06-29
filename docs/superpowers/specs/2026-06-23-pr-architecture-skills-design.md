# PR architecture skills + self-review workflow — design

Date: 2026-06-23
Status: design approved; pending spec review before writing-plans.

## Context

DevDigest already encodes architectural conventions in per-package `CLAUDE.md` files (see [client/CLAUDE.md](../../../client/CLAUDE.md), [server/CLAUDE.md](../../../server/CLAUDE.md)). They live as prose, mixed with operational notes, and are read passively. Two gaps:

1. There is no structured artifact a tool can mechanically check the diff against.
2. There is no "second pass" before claiming a task ready — Claude relies on its own judgment, which drifts.

This design introduces two **instruction skills** that codify the conventions in a structured, severity-tagged form, and one **dispatcher workflow** that runs them as a pre-ready review of the uncommitted diff.

## Goals

- Make the existing architectural rules of `client/` and `server/` enforceable as a checklist, without restructuring the codebase.
- Provide a second-pass review before Claude claims work is "ready", routed by changed surface (client → UI rules; server → Onion rules), composed with the existing framework skills (`react-best-practices`, `react-testing-library` on the client; `fastify-best-practices`, `drizzle-orm-patterns` on the server).
- Stay aligned with the project's global rules: ask before applying fixes; respect the "small frequent local commits" preference (no commit-time hook).

## Non-goals

- Restructuring `modules/`, `adapters/`, `platform/`, or `src/app/` (no new layers introduced).
- Replacing the existing framework-knowledge skills already installed under `.claude/skills/`.
- Hard enforcement via commit hooks. The gate is a soft, model-followed rule. Revisit if drift is observed.

## Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | Rule density of the two instruction skills | **Codify + tighten.** Restate current CLAUDE.md rules plus a small number of new rules listed below. |
| Q2 | Format of the instruction skills | **Hybrid with severity.** A checklist at the top with `MUST` (blocker) / `SHOULD` (advisory), followed by principles & rationale. |
| Q3 | pr-self-review trigger | **Soft auto-gate + slash-invocable.** Claude auto-invokes before claiming "ready" when the diff touches `client/` or `server/`; user can also run `/pr-self-review` manually. No commit hook. |
| Q4 | pr-self-review output | **Findings list with severity → Claude proposes fixes.** Workflow returns structured findings into the calling session. MUST findings block "ready"; for each, Claude proposes a fix and asks before applying. SHOULD findings are listed as advisories and do not block. |

## Artifacts

| Path | Purpose |
|---|---|
| `.claude/skills/ui-architecture/SKILL.md` | Instruction skill for `client/` |
| `.claude/skills/onion-architecture/SKILL.md` | Instruction skill for `server/` |
| `.claude/workflows/pr-self-review.js` | Workflow script (skill dispatcher) |
| `CLAUDE.md` (root, +1 line) | "Before marking work ready, if the diff touches `client/` or `server/`, run `/pr-self-review`." |

## UI-architecture skill — rules

Tag legend: `[codify]` = restated from `client/CLAUDE.md`; `[tighten]` = exists but loose; `[new]` = added under Q1's "tighten" mandate.

### MUST (blockers)

1. No raw `fetch` outside `client/src/lib/api.ts`. `[codify]`
2. No data fetching in components or pages — use TanStack Query hooks in `client/src/lib/hooks/`. `[codify]`
3. Server Components by default; `'use client'` only when interactivity, hooks, or browser-only APIs require it. `[codify]`
4. No cross-page imports — `app/repos/...` may not import from `app/agents/...`. Promote shared code to `src/components/` or `src/lib/`. `[new]`

### SHOULD (advisories)

5. Page-only components live in `app/<route>/_components/` (Next.js private-folder convention, excluded from routing). Promote to `src/components/` on the second reuse. `[new]`
6. Tests colocated as `*.test.ts(x)` next to the file under test. Drop the `__tests__/` sibling option mentioned in current CLAUDE.md. `[tighten]`
7. File naming: PascalCase for component files (`DiffViewer.tsx`); kebab-case for non-component files (`use-repos.ts`, `api.ts`). Next.js-reserved filenames (`page.tsx`, `layout.tsx`, `loading.tsx`) follow the framework convention. `[tighten]`
8. No imports from `src/vendor/` outside its designated consumers. `[new]`

## Onion-architecture skill — rules

### MUST (blockers)

1. **No adapter import in route handlers.** Routes call services from `modules/`; services receive adapters via `platform/container.ts`. `[new]` — keystone.
2. No raw `fetch` / `octokit` / `simple-git` / `fs` / network calls in `modules/`. Every external call goes through an adapter. `[codify]`
3. No `throw new Error()` in routes or modules. Errors must extend a type from `platform/errors.ts`. `[tighten]` — CLAUDE.md restricts only route handlers; extended here to all of `modules/`.
4. No cross-module imports between `modules/X` ↔ `modules/Y`. Shared domain helpers live in `modules/_shared/`; cross-module orchestration goes through a port wired by the container. `[new]`
5. No adapter-to-adapter imports. Adapters are leaves; if A needs B, lift the shared concern to `platform/` or orchestrate via a module. `[new]`
6. All routes register Zod schemas at the request boundary. `[codify]`

### SHOULD (advisories)

7. DI wiring lives in `platform/container.ts`; no `new XAdapter()` outside the container. `[tighten]`
8. `adapters/mocks.ts` is test-only; production code may not import it. `[codify]`
9. Settings-driven state (e.g. LLM provider) is read per request, never cached at boot. `[codify]`
10. Integration tests: filename `*.it.test.ts` + import from `server/test/helpers/pg.ts`. `[codify]`

## Instruction skill — file template

Both skills share the same structure:

```
---
name: ui-architecture            # or onion-architecture
description: <trigger language describing when Claude should auto-invoke,
              e.g. "Use when editing files under client/src/...">
---

# Rules
## MUST
1. <one-line rule>
   Why: <one short sentence>
   Red flag: <pattern or example>

## SHOULD
5. <one-line rule>
   Why: ...
   Red flag: ...

# Principles & rationale
<Short prose, examples for the judgment-call rules>

# Detection hints  (consumed by pr-self-review)
- Rule 1: grep `fetch(` under `client/src/components/` or `client/src/app/` (excluding `client/src/lib/api.ts`)
- Rule 4: cross-imports between `client/src/app/<a>/` and `client/src/app/<b>/`
- Rule N: "manual review" (no mechanical signal)
```

The **Detection hints** section is the seam between the two consumers. Claude reading the skill during dev uses the rules + principles; the pr-self-review agent uses the detection hints to localise checks before reasoning.

## pr-self-review workflow

### Shape

```js
export const meta = {
  name: 'pr-self-review',
  description: 'Second-pass architectural review of uncommitted diff before claiming a task ready.',
  phases: [
    { title: 'Detect surfaces' },
    { title: 'Review' },
    { title: 'Synthesize' },
  ],
}

phase('Detect surfaces')
// changed files = git diff --name-only HEAD ∪ git ls-files --others --exclude-standard
// touchesClient = any path under client/
// touchesServer = any path under server/
// if neither → return { must: [], should: [], skipped: true }

phase('Review')  // parallel
// if touchesClient: spawn agent — load [ui-architecture, react-best-practices,
//   react-testing-library], review client/ hunks, return FINDINGS
// if touchesServer: spawn agent — load [onion-architecture, fastify-best-practices,
//   drizzle-orm-patterns], review server/ hunks, return FINDINGS

phase('Synthesize')
// merge findings; return { must, should, partial }
```

### Findings schema (per item)

```
{
  severity: 'MUST' | 'SHOULD',
  rule:     'ui-arch.MUST.4' | 'onion.MUST.1' | ...,
  file:     string,
  line:     number,
  excerpt:  string,
  why:      string,
  fix_hint: string
}
```

## Data flow at "ready" time

```
Claude about to claim "ready"
  └─► (root CLAUDE.md rule) invoke /pr-self-review
        └─► workflow returns { must, should, partial }
              ├─ must.length > 0 → list each, propose a fix, ASK before applying; block "ready"
              ├─ partial = true  → report which side failed; block "ready" until rerun or explicit user override
              ├─ should.length>0 → list in final summary as advisories (do not block)
              └─ empty           → proceed with "ready"
```

The "ASK before applying" step is required for every MUST fix — consistent with the global rule that risky/architectural changes need explicit confirmation.

## Error handling

| Case | Behavior |
|---|---|
| Empty diff (no uncommitted or untracked files) | Workflow returns `{ must: [], should: [], skipped: true }`. Claude proceeds. |
| One agent errors (LLM timeout, schema mismatch after retries) | Other agent's findings returned + `partial: true`. Claude surfaces the failed side and blocks "ready" until the user reruns or explicitly waives. |
| Both agents error | Empty findings + error flag. Claude does NOT claim "ready". |
| Diff touches only `docs/`, `specs/`, `scripts/`, or `*.md` | Both `touches*` false → skipped. |

## Testing

- **Instruction skills**: hand-verified by introducing a deliberate violation file and asking Claude to review it under the loaded skill. No automated test.
- **pr-self-review workflow**: manual smoke test in a worktree with one known MUST violation per side (e.g. `fetch()` in `client/src/components/`; `octokit` import inside `server/src/modules/repos/`). Confirm both are caught and the proposed fixes are sensible.
- **Dogfood period**: 2 weeks of running `/pr-self-review` on real tasks before promoting the CLAUDE.md line from advisory to "must" wording.

## Risks

- **Soft-gate fragility (Q3).** The "Claude follows the CLAUDE.md rule" path is not enforced. If Claude skips `/pr-self-review`, nothing catches it. Accepted for v1; if drift is observed, escalate to a PreToolUse hook scoped to large diffs.
- **Detection-hint coverage.** A rule without a detection hint is still reviewable (the agent reasons over hunks), but slower and noisier. Aim for hints on all MUST rules; SHOULD rules may legitimately be "manual review".
- **`_shared/` semantics (Onion MUST.4).** Locking `_shared/` as the sole cross-module seam means adding a domain-event mechanism later requires amending the rule. Cheap to amend (the rule lives in a skill, not code), but worth noting.
- **Workflow agent skill loading — unverified.** Each subagent must explicitly invoke the relevant skills before reviewing. Whether workflow subagents have access to the project's Skill registry (and therefore can load `ui-architecture` / `onion-architecture` / `react-best-practices` / etc.) needs to be confirmed during the implementation plan. Fallback: inline the rule checklist into the subagent prompt (heavier, but works without skill access).

## Open items

- Decide the exact root-CLAUDE.md wording for the soft gate (one line).
- Decide whether `/pr-self-review` short-circuits when the diff is below a size threshold (e.g. <10 changed lines). Default for v1: no threshold — run unconditionally when surfaces are touched.
