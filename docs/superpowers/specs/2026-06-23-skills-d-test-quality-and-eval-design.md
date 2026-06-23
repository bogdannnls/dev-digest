# Skills UI — Spec D: Test Quality Reviewer + control experiment — design

Date: 2026-06-23
Status: design approved; pending spec review before writing-plans.
Depends on: [Spec A](2026-06-23-skills-ui-list-editor-design.md) (skills CRUD) AND [Spec B](2026-06-23-skills-b-agent-editor-tab-design.md) (per-agent `enabled` flag — the runtime override mechanism this spec relies on).

## Context

The original brief named two new agents — a **Test Quality Reviewer** that flags missing branches, edge cases, mock overuse, and flakes — and a **control experiment** that proves the skills mechanism actually changes review behaviour:

> Test Quality: PR із тестом лише на happy-path → без скілів (пропуск) проти зі скілами (флагує непокриту гілку й межовий випадок).
> API Contract: PR зі зміною сигнатури роуту → без скілів (пропуск) проти зі скілами (виявляє breaking change).

This spec delivers both: the seed agent + the harness that proves the difference, mounted as an interactive panel inside the Agent Editor → Skills tab (the surface added by Spec B).

## Goals

- A `Test Quality Reviewer` agent is seeded into a fresh workspace alongside the existing reviewer seeds (Security, Performance, etc.).
- The user can run a one-click A/B comparison against a packaged PR fixture from inside the agent editor: "with skills" vs "without skills (this agent's links temporarily disabled for one call)" — side-by-side findings, diff-annotated.
- The control experiment reproduces deterministically: same fixture + same agent config → same result. Reviewer-core's existing determinism (temperature 0, structured output) is the basis.
- Existing reviewer-core path is reused — no new prompt-assembly logic in this spec. The "without skills" run sets `enabled = false` on all links for the duration of the call, runs the standard reviewer, then restores. Same code path, different input.

## Non-goals

- A general "Evals" tab — that's a separate, larger spec ("Eval Dashboard" was a placeholder in the design HTML). This spec puts the harness on the Skills tab specifically, scoped to "does linking these skills change findings?"
- Persistent eval runs / history. The result lives in the modal for the session. If the user wants a record, they screenshot or copy-paste. (A real eval log is the future Evals tab.)
- Multiple fixtures in one run / score aggregation across fixtures.
- A "ground truth" comparison (asserting findings A vs. expected findings B). The harness only diffs `with` vs `without`; "is the with-skills run *better*?" is the user's judgment.
- Net-new prompt-assembly logic for skills. The reviewer-core spec that consumes the per-skill `enabled` flag lands separately; this spec assumes it (and is co-developed if needed).

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where does the harness UI live? | A "Compare with vs without skills" button on the Skills tab inside the agent editor. Click opens a modal. | Keeps it scoped to the surface that explains "what do these skills change". Doesn't pollute the deferred Evals tab. |
| 2 | How is "without skills" achieved on the server? | Per-request override: the eval endpoint loads the agent, reads its linked skills, runs the reviewer once with them as-loaded (the "with" run), runs a second time after **synthetically setting `link.enabled = false` for all links in the in-memory DTO** (no DB writes). | Cleanest separation. The DB never lies about the user's true state. The reviewer-core path takes the DTO and assembles the prompt; flipping the flag in memory is the override. |
| 3 | Fixtures | A handful of hand-crafted PR diff fixtures committed to `server/test/fixtures/prs/` as JSON, each containing `{ id, title, files: { path, patch, before, after }[], expected_categories: string[] }`. Two ship in v1: `test-only-happy-path.json` (the Test Quality case) and `api-contract-change.json` (the API Contract case). | Deterministic, repo-local, reviewable in PRs. |
| 4 | Where does the Test Quality Reviewer get seeded? | A new optional flag on the existing seed (`pnpm db:seed --with-skills`) creates: a `test-coverage-nudge` skill (body from the design HTML), the `Test Quality Reviewer` agent, and links the skill to the agent. | Re-runnable; idempotent (uses ON CONFLICT). |
| 5 | UI for findings diff | Two columns side-by-side. Each finding row carries a small badge: `NEW` (green) if it appears only in the "with skills" set, `MISSING` (red) if only in "without", neither badge if it appears in both. Diff is structural (matches on `{file, line, message}` similarity — exact `file:line` match required, message via a simple normalised-substring check). | Communicates the value of the skill without requiring user mental diffing. |
| 6 | Cost / token disclosure | Each side shows actual tokens used + cost estimate (the reviewer-core run already returns this). User sees that two LLM calls happen. | Honest about the cost of the experiment. |
| 7 | Concurrency / cancellation | The two runs are sequential server-side (no parallel LLM calls — provider rate-limit-friendly). The modal has a Cancel button that aborts the streaming request; the server treats abort as best-effort. | Simplicity. v1 doesn't need parallelism. |

## Architecture

### Server

**New endpoint** ([server/src/modules/agents/routes.ts](../../../server/src/modules/agents/routes.ts)):

```ts
POST /agents/:id/skills-eval
body { fixture_id: string }
returns { with_skills: ReviewerOutput, without_skills: ReviewerOutput, fixture: PRFixtureMeta }
```

- 404 if agent missing or cross-workspace.
- 404 if fixture id not known.
- 422 if body shape wrong.
- Streams progress events through the existing SSE bus (`platform/sse.ts`) so the modal can show "Running with skills…" → "Running without skills…" → done. The HTTP body of the POST is the final result; intermediate progress goes through SSE just like other long-running reviewer flows.

**Service method** ([server/src/modules/agents/service.ts](../../../server/src/modules/agents/service.ts)):

```ts
async evaluateSkillsAB(
  workspaceId: string,
  agentId: string,
  fixtureId: string,
): Promise<{ with_skills: ReviewerOutput; without_skills: ReviewerOutput; fixture: PRFixtureMeta }>
```

Steps:

1. Load the agent DTO. 404 if missing.
2. Load the fixture from `server/test/fixtures/prs/<id>.json`. 404 if missing.
3. Build the reviewer input from the fixture (same shape the real review path uses for a real PR).
4. **With-skills run**: load `linkedSkills(agentId)` as-is, call `reviewer-core.runReview(input, { agent, skills })`. Capture output.
5. **Without-skills run**: take the same `linkedSkills` array but map each to `{ ...link, enabled: false }` (in memory). Call `reviewer-core.runReview` again with the modified skills array. Capture output.
6. Return both.

The DB is never mutated during eval. The override is a pure data transform.

**Fixture loader** (new — `server/src/modules/agents/eval-fixtures.ts`):

```ts
export interface PRFixture {
  id: string;
  title: string;
  files: Array<{ path: string; patch: string; before?: string; after?: string }>;
  notes?: string;
}

export function listFixtures(): PRFixtureMeta[];
export function loadFixture(id: string): PRFixture | undefined;
```

Reads the JSON files at startup, caches in memory. Strict JSON Schema validation on load.

**New fixtures** under `server/test/fixtures/prs/`:

- `test-only-happy-path.json` — a diff that adds a function + a single happy-path test. The Test Quality skill's body should pattern-match against "happy path only" and flag missing branch coverage.
- `api-contract-change.json` — a diff that changes a public route's signature (Zod shape, e.g.). The Test Quality skill plus a hypothetical API Contract skill should flag the breaking change.

Each fixture also gets a per-file `before/after` snapshot so the reviewer can ground its findings on real-looking code.

**Seed extension** ([server/src/db/seed.ts](../../../server/src/db/seed.ts)):

Add an optional `--with-skills` CLI flag (default off; current `pnpm db:seed` doesn't change behaviour). When the flag is on:

1. Upsert two skills: `test-coverage-nudge` (type: `rubric`) and `api-contract-gate` (type: `security`). Bodies are markdown sourced from the design HTML's skills list — committed verbatim into `server/src/db/seed-skills.ts` as string constants.
2. Upsert the `Test Quality Reviewer` agent with provider `anthropic`, model `claude-haiku-4-5-20251001` (cheap default), system prompt: "You are a test quality reviewer. Examine the diff for missing branch coverage, untested edge cases, over-mocking, and likely flakes. Cite exact file:line."
3. Link both skills to the agent (`order: 0, 1`, `enabled: true`).

**Shared contract** (`server/src/vendor/shared/contracts/eval-ci.ts` already has eval shapes — extend or mirror): add `PRFixtureMeta` and `SkillsEvalResult` to a new file under `contracts/` or under `agent.ts`. Keep eval-CI separate; this is a per-agent skills A/B, not a CI eval run.

### Client

**Hook** ([client/src/lib/hooks/agents.ts](../../../client/src/lib/hooks/agents.ts)):

```ts
useSkillsEval(agentId)
  // wraps a useMutation; mutate({ fixture_id })
  // emits intermediate phase events from SSE for the UI
```

**Components** (under `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/`):

```
_components/
  SkillsEvalModal/
    SkillsEvalModal.tsx                # picker + run button + results
    SkillsEvalModal.test.tsx
    _components/
      FixturePicker/                   # dropdown of available fixtures
      EvalResultsSplit/                # two-column finding diff view
      FindingRow/                      # one finding row with NEW/MISSING badge
    styles.ts
    index.ts
```

The Skills tab (Spec B) gains a small "Compare with vs without skills" button next to the order hint, only visible when the agent has at least one enabled linked skill. Disabled if no fixtures are available (server returns `[]`).

`SkillsEvalModal`:

- State machine: `picker → running → results → error`.
- The `running` state shows the SSE phase: "Running with skills…" → "Running without skills…" → done. A spinner with the phase text.
- The `results` state renders the two finding sets side-by-side, each finding diff-annotated.
- The `error` state shows the error + retry.

`EvalResultsSplit`:

- Two columns: "With skills" (left) | "Without skills" (right).
- Each row: severity dot · file:line · message · `NEW` / `MISSING` badge.
- Header on each column: total findings, tokens, cost estimate.
- Empty findings: "No findings" inside the column.

`FixturePicker`:

- Reads `useFixturesList()` (a new GET endpoint `/agents/eval-fixtures` returning `PRFixtureMeta[]` — independent of any agent).
- Defaults to the first fixture.

### i18n

Extend `client/messages/en/agents.json`:

```json
{
  "skills": {
    "evalButton": "Compare with vs without skills",
    "evalEmpty": "Link at least one skill to compare."
  },
  "eval": {
    "title": "Skills A/B",
    "subtitle": "Run this agent on a packaged PR fixture, once with linked skills and once without. Two LLM calls.",
    "fixtureLabel": "PR fixture",
    "run": "Run comparison",
    "running": "Running…",
    "phaseWith": "Running with skills…",
    "phaseWithout": "Running without skills…",
    "withColumn": "With skills",
    "withoutColumn": "Without skills",
    "noFindings": "No findings",
    "badge": {
      "new": "NEW",
      "missing": "MISSING"
    },
    "tokens": "{n} tokens",
    "cost": "${cost}",
    "noFixtures": "No fixtures available.",
    "error": "Could not run the comparison.",
    "retry": "Retry"
  }
}
```

## Components & data flow

```
SkillsTab → "Compare with vs without skills" button
  → opens SkillsEvalModal (picker state)
  → user picks fixture, clicks Run
  → SkillsEvalModal switches to running state
  → useSkillsEval.mutate({ fixture_id })
    → POST /agents/:id/skills-eval
    → server: load agent + fixture
    → server: with-skills run (reviewer-core, links as-is)
    → SSE: 'phase: with-done'
    → server: without-skills run (links overridden to enabled=false)
    → SSE: 'phase: without-done'
    → HTTP body returns { with_skills, without_skills, fixture }
  → SkillsEvalModal switches to results state
  → EvalResultsSplit annotates each finding NEW/MISSING by comparing the two sets via (file, line, normalised message similarity)
```

## Error handling & edge cases

- **No fixtures available**: hide the button entirely, show the `evalEmpty` hint on hover of a disabled placeholder.
- **No enabled skills linked**: button disabled with `evalEmpty` tooltip — the comparison would be vacuous.
- **LLM provider key missing**: server returns 500 with the existing `config_error` code; modal shows the upstream error message + a link to Settings.
- **Token limit exceeded on one of the runs**: that side renders findings up to truncation + a warning chip "Truncated at N tokens". The diff still works for the findings that landed.
- **User cancels mid-run**: the mutation throws an abort error; the modal returns to the picker state.
- **Reviewer-core returns a different output shape on with vs without**: both runs share the same code path; the diff logic assumes the shape is identical. If it isn't (bug), the diff falls back to rendering both columns un-annotated.
- **The "without skills" run still has the skill body in the prompt because of caching**: not applicable — reviewer-core assembles the prompt per call; no agent-side memoisation of the assembled prompt exists today.

## Test plan

Server (vitest):

| File | Cases |
|---|---|
| `server/test/skills-eval.it.test.ts` | POST /agents/:id/skills-eval returns both runs · the "without skills" run sees `enabled: false` on every link (assert via a mock LLM adapter that captures the input to `runReview`) · 404 on unknown agent · 404 on unknown fixture · 404 cross-workspace · DB is unchanged after the call (count + queries match pre-state) |
| `server/test/eval-fixtures.test.ts` | `loadFixture` returns parsed JSON · validation rejects malformed fixture files · listFixtures returns metadata for all valid files in the dir |
| `server/test/seed-skills.it.test.ts` | `pnpm db:seed --with-skills` creates the two seed skills, the Test Quality agent, links both · re-running is idempotent (same row count, same versions) · `pnpm db:seed` without the flag leaves skills + Test Quality agent absent |

Client (vitest + jsdom + RTL):

| File | Cases |
|---|---|
| `SkillsEvalModal.test.tsx` | renders picker · Run calls `useSkillsEval` · running state shows phase text via mocked SSE · results state renders both columns with the right counts · NEW/MISSING badges appear in the right column · error state shows + Retry · Cancel aborts the running mutation |
| `EvalResultsSplit.test.tsx` | finding present in both sets renders without a badge · finding in `with` only gets NEW · finding in `without` only gets MISSING · empty state per column · totals/tokens/cost render |

## Acceptance criteria

- `pnpm db:seed --with-skills` produces a `Test Quality Reviewer` agent in a fresh workspace, with two skills linked.
- Opening that agent's editor → Skills tab shows both skills, both enabled.
- The "Compare with vs without skills" button is visible and enabled.
- Clicking it opens the modal, lets the user pick a fixture, and Run produces two finding sets within the model's normal turn time (~3-10s each, sequential).
- The `test-only-happy-path.json` fixture, with skills enabled, produces at least one finding tagged with the missing-branch concept. Without skills, it produces zero or fewer findings on that concept. (This is the "control experiment passes" criterion.)
- The DB is unchanged before and after a comparison run.
- The user can re-run the same comparison and get the same findings (provider determinism permitting — note in the spec that LLMs aren't bitwise deterministic; the test asserts categories, not exact strings).

## Open questions

- **Determinism of LLM output**: even at temperature 0, providers can return slightly different findings across runs. The acceptance criterion above asserts *categories* (missing-branch concept), not exact match. If reviewer-core's output is more variable than expected, we may need to broaden the assertion.

## References

- Spec A: [docs/superpowers/specs/2026-06-23-skills-ui-list-editor-design.md](2026-06-23-skills-ui-list-editor-design.md)
- Spec B: [docs/superpowers/specs/2026-06-23-skills-b-agent-editor-tab-design.md](2026-06-23-skills-b-agent-editor-tab-design.md)
- Design HTML frame "Run Trace · live log" (the SSE phase-event pattern this spec mirrors): [docs/DevDigest Design (standalone).html](../../DevDigest%20Design%20%28standalone%29.html)
- Existing reviewer-core entry point: [server/src/modules/reviews/run-executor.ts](../../../server/src/modules/reviews/run-executor.ts) (used as the pattern for how `runReview` is invoked from a route handler)
