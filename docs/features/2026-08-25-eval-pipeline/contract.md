# Frozen interface contract — Eval Pipeline (L06)

Version: **v1.3**
Frozen: 2026-08-25 (v1.1 corrects section 5.5 only - the missing-i18n-key list was
incomplete. Corrected before any task was dispatched against that section.)
Owner: lead (`team-integrate`). No implementer edits this file. A role that believes a
section is wrong must escalate; only the lead re-opens and bumps the version.

Sections are numbered so a context packet can cite one instead of shipping the whole file.

---

## §0 Ground truths this contract is built on (verified during recon)

- `eval_cases` and `eval_runs` **already exist** — `server/src/db/schema/eval.ts:7-35`,
  created by `server/src/db/migrations/0000_init.sql:116-127`. They are unused by any route.
- L06 API contracts **already exist** — `server/src/vendor/shared/contracts/eval-ci.ts`
  (`EvalCaseInput`, `EvalRunRecord`, `EvalRunResult`, `EvalTrendPoint`, `EvalDashboard`).
  Base `EvalRun`, `EvalCase`, `EvalOwnerKind` in `contracts/knowledge.ts:50-85`.
- `reviewPullRequest(input: ReviewInput): Promise<ReviewOutcome>` —
  `reviewer-core/src/review/run.ts:123` — takes a **pre-parsed `UnifiedDiff`**, a
  `systemPrompt`, a `model`, and an injected `LLMProvider`. It needs no PR, no repo,
  no clone. Precedent caller: `AgentsService.evaluateSkillsAB`,
  `server/src/modules/agents/service.ts:258-296`.
- `ReviewOutcome.dropped: {finding, reason}[]` already exposes every finding the grounding
  gate removed (`reviewer-core/src/review/run.ts:101`). **The grounding gate is NOT
  touched by this feature** — it is a declared do-not-touch zone in both
  `server/CLAUDE.md` and `reviewer-core/CLAUDE.md`.
- `parseUnifiedDiff(raw: string): UnifiedDiff` — `server/src/adapters/git/diff-parser.ts:14`.
- Per-file patches are persisted in `pr_files.patch`, so a case's diff fragment is
  derivable offline — no GitHub call, no clone. Precedent: `diffFromPrFiles`,
  `server/src/modules/reviews/diff-loader.ts:31-42`.
- A module reading another domain's table through **its own repository** is established
  practice (`server/src/modules/reviews/repository/run.repo.ts:23` joins `t.agents`).
  Module-to-module *imports* remain forbidden (onion MUST.4).

---

## §1 Data model

### §1.1 `eval_cases` — existing table, no schema change

Column usage is fixed as follows. Implementers must not repurpose a column.

| column | use |
|---|---|
| `owner_kind` | always `'agent'` for this feature |
| `owner_id` | `agents.id` |
| `name` | short human label, unique per owner, e.g. `stripe-key-leak` |
| `input_diff` | the unified-diff fragment, **non-empty**, must parse to >= 1 file |
| `input_files` | unused - always `null` |
| `input_meta` | `EvalCaseMeta` (section 2.2) |
| `expected_output` | `EvalExpectation` (section 2.1) |
| `notes` | free text, nullable |

`eval_cases` has no `created_at`. Ordering is by `name` ascending; do not invent a
timestamp column.

### §1.2 `eval_run_batches` — NEW table, migration `0018_eval_run_batches.sql`

One row per **set-run** (the thing a user calls a "run" and compares two of).

```
id                 uuid primary key default gen_random_uuid()
workspace_id       uuid not null references workspaces(id) on delete cascade
owner_kind         text not null            -- 'agent' | 'skill'; this feature writes 'agent'
owner_id           uuid not null
agent_version      integer                  -- snapshot of agents.version at run time; nullable
system_prompt      text not null            -- verbatim snapshot, powers the prompt-diff view
model              text not null
provider           text not null
ran_at             timestamptz not null default now()
finished_at        timestamptz
status             text not null default 'running'   -- 'running' | 'succeeded' | 'failed'
cases_total        integer not null
traces_passed      integer not null default 0
recall             double precision         -- nullable, see section 3.4
precision          double precision         -- nullable, see section 3.4
citation_accuracy  double precision         -- nullable, see section 3.4
duration_ms        integer
cost_usd           double precision
tokens_in          integer
tokens_out         integer
error              text
```

`precision` is a reserved word in some dialects but a legal unquoted identifier in
Postgres; `eval_runs` already uses it (`0000_init.sql`). Keep the name for symmetry.

### §1.3 `eval_runs` — existing table, one added column

```
alter table eval_runs add column batch_id uuid references eval_run_batches(id) on delete cascade;
```

`case_id` stays `NOT NULL`: an `eval_runs` row remains **one case executed once**.
`batch_id` is nullable only so the ALTER is safe on existing rows; every row this
feature writes sets it.

### §1.4 Migration mechanics (non-negotiable)

- File: `server/src/db/migrations/0018_eval_run_batches.sql`. Migrations are
  **append-only** - never edit 0000-0017.
- Statements separated by `--> statement-breakpoint`.
- A new entry **must** be appended to
  `server/src/db/migrations/meta/_journal.json`:
  `{ "idx": 18, "version": "7", "when": <epoch ms>, "tag": "0018_eval_run_batches", "breakpoints": true }`.
  Drizzle's migrator reads the journal, not the filesystem - a `.sql` without a journal
  entry is silently never applied (INSIGHTS.md 2026-06-23).
- Drizzle schema: `server/src/db/schema/eval.ts` is **extended in place** with
  `evalRunBatches` and the `batchId` column on `evalRuns`; the table must also be
  registered in the `schema` object in `server/src/db/schema.ts`.
- Follow the 0014-0017 precedent: hand-written SQL + journal entry, no `meta/*_snapshot.json`.

---

## §2 Shared contracts — `contracts/eval-ci.ts`

All additions go in `server/src/vendor/shared/contracts/eval-ci.ts` and must be
**mirrored byte-for-byte** into `client/src/vendor/shared/contracts/eval-ci.ts`. The two
vendor trees are separate copies aliased to the same `@devdigest/shared` specifier; a
change to one without the other is a defect.

### §2.1 `EvalExpectation` — new

```ts
export const EvalExpectationKind = z.enum(['must_find', 'must_not_flag']);

export const EvalExpectation = z.object({
  kind: EvalExpectationKind,
  file: z.string().min(1),
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
  // Display-only. NEVER read by the scorer (section 3).
  severity: Severity.nullish(),
  category: FindingCategory.nullish(),
  title: z.string().nullish(),
});
```

Refinement: `end_line >= start_line`.

**Only `kind`, `file`, `start_line`, `end_line` participate in scoring.** `severity`,
`category` and `title` exist so the Evals-tab list can render the badges the design shows.
An implementer that scores on severity has broken this contract.

### §2.2 `EvalCaseMeta` — new

```ts
export const EvalCaseMeta = z.object({
  source_finding_id: z.string().nullish(),
  source_pr_id: z.string().nullish(),
  source_review_id: z.string().nullish(),
  origin: z.enum(['finding', 'manual']),
});
```

### §2.3 `EvalCaseManualInput` — new (Case Editor)

```ts
export const EvalCaseManualInput = z.object({
  name: z.string().min(1),
  input_diff: z.string().min(1),
  expected_output: EvalExpectation,
  notes: z.string().nullish(),
});
```

### §2.4 `EvalBatchRecord` — new

```ts
export const EvalBatchRecord = z.object({
  id: z.string(),
  owner_kind: EvalOwnerKind,
  owner_id: z.string(),
  agent_version: z.number().int().nullable(),
  model: z.string(),
  provider: z.string(),
  ran_at: z.string(),
  finished_at: z.string().nullable(),
  status: z.enum(['running', 'succeeded', 'failed']),
  cases_total: z.number().int(),
  traces_passed: z.number().int(),
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  duration_ms: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  error: z.string().nullable(),
});
```

`system_prompt` is deliberately **absent** from the list record - it can be multi-KB and
the runs table renders dozens of rows. It is carried only by 2.5 and 2.6.

### §2.5 `EvalBatchDetail` — new

```ts
export const EvalBatchDetail = z.object({
  batch: EvalBatchRecord,
  system_prompt: z.string(),
  cases: z.array(EvalRunRecord),   // existing per-case contract, reused as-is
});
```

### §2.6 `EvalRunComparison` — new

```ts
export const EvalRunComparison = z.object({
  a: EvalBatchRecord,              // the older run
  b: EvalBatchRecord,              // the newer run
  system_prompt_a: z.string(),
  system_prompt_b: z.string(),
  delta: z.object({
    recall: z.number().nullable(),
    precision: z.number().nullable(),
    citation_accuracy: z.number().nullable(),
    cost_usd: z.number().nullable(),
  }),
});
```

`delta.X = b.X - a.X`, or `null` when either side is `null`. The client renders the
prompt diff; the server ships both prompts verbatim and computes no diff.

### §2.7 `EvalDashboardIndex` — new (the sidebar page's landing view)

```ts
export const EvalDashboardAgentSummary = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  model: z.string(),
  cases_total: z.number().int(),
  last_run: EvalBatchRecord.nullable(),
  trend: z.array(EvalTrendPoint),          // existing contract, reused as-is
});

export const EvalDashboardIndex = z.object({
  agents: z.array(EvalDashboardAgentSummary),
  recent_runs: z.array(
    EvalBatchRecord.extend({ agent_name: z.string() }),
  ),
});
```

### §2.8 One change to a shipped contract

`EvalDashboard.recent_runs` changes element type from `EvalRunRecord` (per-case) to
`EvalBatchRecord` (per-run). Justification: the dashboard's "Recent runs" table is a list
of runs, not of case executions; `EvalDashboard` has **zero consumers** today, so this is
not a breaking change in practice. Retiring/repurposing a dormant contract as part of the
feature that first needs it is established practice here (SPEC-02 retired the dormant
`PrBrief` composite the same way). Everything else in `EvalDashboard` - `current`,
`delta`, `trend`, `alert` - is kept and used verbatim.

**Ruling on the `current` / `delta` nullability contradiction (v1.3).** The spec author
escalated that §2.8's "kept and used verbatim" collides with §3.4: an agent whose newest
run produced no findings has `precision === null`, which the shipped non-nullable
`z.number()` on `EvalDashboard.current` cannot carry. Resolution: **widen**
`EvalDashboard.current.recall`, `.precision`, `.citation_accuracy` and all three fields of
`EvalDashboard.delta` to `.nullable()`. Coercing a `null` metric to `0` on the dashboard
was rejected: it makes an agent that produced nothing indistinguishable from an agent that
scored zero, which is precisely the silent-wrong-answer failure §3.4 exists to prevent.
`EvalDashboard` has zero consumers, so widening costs nothing. This also aligns
`EvalDashboard.delta` with `EvalRunComparison.delta` (§2.6), which was already nullable —
the two delta shapes must not disagree.

`EvalRunResult` and `EvalCaseInput` stay **dormant and untouched**: this feature runs
every case as a batch (4.1), so there is no single-case result shape to return, and case
creation uses 2.3 / 4.4 instead of `EvalCaseInput`. Do not delete them.

---

## §3 Scoring — deterministic, zero LLM calls

The scorer lives in **`reviewer-core/src/eval/score.ts`**, exported from
`reviewer-core/src/index.ts`. It is a pure function: no `fs`, no `fetch`, no
`process.env`, no import from `reviewer-core/src/llm/**`. That module boundary is what
makes "scoring makes no LLM call" structurally true rather than merely asserted.

### §3.1 Match predicate

```
matches(finding, exp) :=
      normalize(finding.file) === normalize(exp.file)
  AND NOT (finding.end_line < exp.start_line OR finding.start_line > exp.end_line)
```

`normalize(p)` strips a single leading `./` and trims whitespace. Nothing else - no
basename fallback, no case folding, no fuzzy path matching.

Line ranges are inclusive on both ends. Findings and expectations both use the
snake_case `start_line` / `end_line` of the wire `Finding` contract
(`contracts/findings.ts:47-63`).

### §3.2 Per-case outcome

Input per case: the `EvalExpectation` and the **post-grounding** finding list
(`outcome.review.findings`).

- `must_find` - iterate findings in returned order. The **first** finding satisfying
  `matches` is the case's true positive; the case `pass = true`. Every other finding
  produced for this case is a false positive. If no finding matches, `pass = false` and
  every finding produced is a false positive.
- `must_not_flag` - `pass = true` iff **no** finding satisfies `matches`. A
  `must_not_flag` case can never produce a true positive, so **every** finding it
  produces is a false positive.

### §3.3 Batch metrics

Let, summed over every case in the batch:

- `TP` = number of `must_find` expectations satisfied (<= 1 per case, by 3.2)
- `F`  = total findings produced across all cases (post-grounding)
- `MF` = number of `must_find` cases
- `kept` = sum of `outcome.review.findings.length`
- `dropped` = sum of `outcome.dropped.length`

Then:

```
recall            = TP / MF
precision         = TP / F
citation_accuracy = kept / (kept + dropped)
traces_passed     = number of cases with pass = true
traces_total      = cases_total
```

`precision = TP / F` is the **strict** definition, chosen deliberately: a finding is
credited only when the dataset positively vouches for it. Its known cost is that a
genuinely new second bug inside a `must_find` case's diff scores as noise. Its benefit is
that prompt noise moves the metric immediately and visibly, which is the whole point of
the sensitivity experiment.

`pass` and `precision` are two distinct lenses on purpose: a `must_find` case passes when
it finds the expected thing, even if it also emitted noise; that noise still lowers
`precision`. Do not collapse them.

### §3.4 Vacuous denominators

Every metric is `null` when its denominator is zero - never `0`, never `1`:

- `MF == 0` -> `recall = null`
- `F == 0` -> `precision = null`
- `kept + dropped == 0` -> `citation_accuracy = null`

The client renders `null` as an em dash. `EvalTrendPoint` requires non-null numbers, so a
batch with a `null` metric is **omitted from the trend series** rather than coerced.

### §3.5 Landed API (filled in after T2; cite these exact names)

`reviewer-core/src/eval/score.ts`, re-exported from `reviewer-core/src/index.ts`:

```ts
type EvalExpectationKind = 'must_find' | 'must_not_flag';
interface EvalExpectationLike { kind; file; start_line; end_line }
interface EvalCaseScoreInput { expectation; findings: Finding[]; kept: number; dropped: number }
interface CaseScore  { pass; matchedFindingId: string | null; truePositives; falsePositives }
interface BatchScore { recall; precision; citation_accuracy; traces_passed; traces_total }

function matches(finding, expectation): boolean
function scoreCase(expectation, findings): CaseScore
function scoreBatch(cases: EvalCaseScoreInput[]): BatchScore
```

`matchedFindingId` clarification (the contract fixed the name, not its
`must_not_flag` meaning): it is the id of the **first** finding satisfying `matches`,
for both kinds. On a `must_find` case that is the true positive. On a `must_not_flag`
case it is the offending finding that caused `pass = false`, and it is `null` when the
case passes. Persist it into `actual_output.matched_finding_id` (§4.7) unchanged.

`server/src/modules/_shared/diff-fragment.ts` (from T3):

```ts
interface DiffFragmentSource { path: string; patch: string | null }
function assembleDiffFragment(files: DiffFragmentSource[]): string
```

It performs string assembly only — the caller fetches the rows and calls
`parseUnifiedDiff` itself. Records with a null/empty patch are skipped.

---

## §4 Server API — new module `server/src/modules/eval/`

Layout mirrors `modules/agents/`: `routes.ts` (default-export Fastify plugin),
`service.ts`, `repository.ts`. Registered by adding one entry to
`server/src/modules/index.ts`.

Every handler starts with `const { workspaceId } = await getContext(app.container, req)`.
Every route declares a Zod `schema`. Errors throw typed classes from
`platform/errors.ts` - never `throw new Error()`.

**Route-ordering trap**: literal segments must be registered before `/:id` uuid routes
(precedent `modules/agents/routes.ts:100-102`).

### §4.1 Runs

| method | path | body | 2xx |
|---|---|---|---|
| POST | `/agents/:id/eval-runs` | `{ case_ids?: string[] }` | 201 `EvalBatchDetail` |
| GET | `/agents/:id/eval-runs` | - | 200 `EvalBatchRecord[]` |
| GET | `/agents/:id/eval-runs/:batchId` | - | 200 `EvalBatchDetail` |
| GET | `/agents/:id/eval-runs/compare` | query `a`, `b` | 200 `EvalRunComparison` |

`POST /agents/:id/eval-runs` with no body (or `case_ids` omitted) runs **all** cases of
the agent. `case_ids` present runs exactly that subset - this is how the per-case run
action in the design is served. **A single-case run is a batch of one**; there is no
separate single-case route and no separate single-case response shape.

`GET .../eval-runs` returns newest-first, default limit 20, `?limit=` capped at 100.

`.../compare` requires both `a` and `b` to belong to this agent; otherwise 404. If
`a.ran_at > b.ran_at` the server swaps them so `a` is always the older run.

Errors: unknown agent -> 404. Agent has zero cases -> 422 `ValidationError`
("agent has no eval cases"). Unknown batch id -> 404.

### §4.2 Cases

| method | path | body | 2xx |
|---|---|---|---|
| GET | `/agents/:id/eval-cases` | - | 200 `EvalCase[]` (`expected_output` typed as `EvalExpectation`) |
| POST | `/agents/:id/eval-cases/from-finding` | `{ finding_id: string }` | 201 `EvalCase` |
| POST | `/agents/:id/eval-cases` | `EvalCaseManualInput` | 201 `EvalCase` |
| PUT | `/agents/:id/eval-cases/:caseId` | `EvalCaseManualInput` | 200 `EvalCase` |
| DELETE | `/agents/:id/eval-cases/:caseId` | - | 204 |

### §4.3 Dashboard

| method | path | 2xx |
|---|---|---|
| GET | `/eval-dashboard` | 200 `EvalDashboardIndex` |
| GET | `/eval-dashboard/:agentId` | 200 `EvalDashboard` |

`EvalDashboard.current` = the newest batch's metrics, `null` propagated as `null`
(never coerced — see the v1.3 ruling in §2.8). `delta` = newest minus previous, and is
`null` for a given metric when there is no previous run or when either side's metric is
`null`. `alert` = a one-line string when any metric moved down by at least 0.02 between
the two newest runs, else `null`; a `null` metric on either side never produces an alert.

### §4.4 Deriving a case from a finding

Fully offline - no GitHub call, no clone.

1. Load the finding, its `review`, and the review's `pull`.
2. Expectation kind: `accepted_at != null` -> `must_find`; `dismissed_at != null` ->
   `must_not_flag`; **neither** -> 422 `ValidationError`
   ("finding has no accept/dismiss decision"). Never default a kind.
3. `expected_output` = `{ kind, file: finding.file, start_line, end_line, severity,
   category, title }`.
4. `input_diff` = the single-file fragment for `finding.file`, assembled from
   `pr_files.patch`:
   ```
   diff --git a/<path> b/<path>
   --- a/<path>
   +++ b/<path>
   <patch>
   ```
   If no `pr_files` row for that path has a non-null `patch` -> 422
   ("no stored patch for <path>").
5. `name` = a slug derived from the finding title, de-duplicated per owner by appending
   `-2`, `-3`, and so on.
6. `input_meta` = `{ origin: 'finding', source_finding_id, source_pr_id, source_review_id }`.
7. Re-clicking on the same finding is **idempotent**: if a case with the same
   `source_finding_id` already exists for this agent, return it with 200 instead of
   creating a duplicate.

The patch-assembly helper is hoisted to `server/src/modules/_shared/` so both
`modules/reviews` and `modules/eval` use one implementation - `modules/eval` importing
`modules/reviews` is forbidden by onion MUST.4. Precedent: commit `31e1c67`
"hoist smart-diff + latest-review helpers to modules/_shared".

### §4.5 Frozen run inputs

For every case, in order, sequentially (provider rate limits preclude parallelism -
precedent `evaluateSkillsAB`):

```ts
reviewPullRequest({
  systemPrompt: agent.systemPrompt,
  model: agent.model,
  diff: parseUnifiedDiff(evalCase.inputDiff),
  llm: await container.llm(agent.provider),
  strategy: agent.strategy ?? 'auto',
  ...(skillBodies.length > 0 ? { skills: skillBodies } : {}),
  task: `Eval case - ${evalCase.name}`,
  sessionId: `eval:${agentId}:${batchId}`,
})
```

Deliberately **not** passed, because a synthetic diff has no repository behind it:
`callers`, `repoMap`, `specs` (project context), `prDescription`. This mirrors the
existing skills-eval harness (`server/test/skills-eval.it.test.ts:175` asserts the same
omission) and is what makes two runs of different agent versions comparable. It is a
known, intentional divergence from a production review - state it in the spec, do not
silently "fix" it.

`skillBodies` = the agent's enabled skill bodies. A prompt change is not the only thing
this harness must detect; a skill relink must move the metrics too.

### §4.6 Per-case failure isolation

- `input_diff` that parses to zero files -> that case records `pass = false`,
  `actual_output = { error: 'diff fragment parsed to zero files' }`, and the batch
  continues. (Trap: a fragment starting bare at `@@` with no `+++` line yields
  `path: ''` and is filtered out by the parser.)
- An LLM/provider error on a case -> same treatment, `actual_output = { error: <message> }`,
  batch continues.
- A failed case contributes to `cases_total` and to `traces_total`, contributes no
  findings, and its `must_find` expectation counts as missed in `recall`.
- Batch `status = 'failed'` only when **every** case errored; otherwise `'succeeded'`.

### §4.7 `actual_output` shape on `eval_runs`

```ts
{
  findings: Finding[],          // post-grounding, as returned
  dropped: number,              // outcome.dropped.length
  grounding: string,            // outcome.grounding, e.g. "1/2 passed"
  matched_finding_id: string | null,
  error?: string,
}
```

---

## §5 Client

### §5.1 Hooks

New file `client/src/lib/hooks/eval.ts`, re-exported from
`client/src/lib/hooks/index.ts`. All access goes through `client/src/lib/api.ts` - no raw
`fetch`, no `api.*` call outside `lib/hooks/` (ui-architecture MUST.1/MUST.2).

Query keys: `["eval-cases", agentId]`, `["eval-runs", agentId]`,
`["eval-batch", batchId]`, `["eval-compare", agentId, a, b]`, `["eval-dashboard"]`,
`["eval-dashboard", agentId]`.

Responses are validated with the Zod contracts (`.parse()`), following the precedent
already set in this domain by `api.getEvalFixtures` / `api.runSkillsEval`
(`client/src/lib/api.ts:84-95`), not the bare-cast style used elsewhere.

### §5.2 Shared components

The Evals tab and the Eval Dashboard both render metric tiles and a runs table, and
cross-page imports are forbidden (ui-architecture MUST.4). Shared pieces therefore live
in `client/src/components/eval/`:

- `EvalMetricTiles` - recall / precision / citation accuracy / traces passed, using the
  existing `MetricCard` primitive; renders an em dash for `null`.
- `EvalRunsTable` - the runs list with selection checkboxes, using the existing
  grid-based table convention (there is no `<table>` anywhere in `src/app`).
- `EvalRunComparison` - the compare modal, using the existing `Modal` primitive.

### §5.3 Surfaces

| surface | path |
|---|---|
| Evals tab | `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/` |
| Dashboard page | `client/src/app/eval-dashboard/page.tsx` (thin) |
| Dashboard view | `client/src/app/eval-dashboard/_components/EvalDashboardView/` |
| Case editor modal | `.../EvalsTab/_components/EvalCaseModal/` |
| Comparison modal | `client/src/components/eval/EvalRunComparison/` |

Each component directory follows the local convention: `Name.tsx`, `styles.ts`
(a `const s` of `satisfies CSSProperties`, CSS custom properties for colour),
`index.ts`, colocated `Name.test.tsx`. No Tailwind classes - this codebase styles with
inline style objects and CSS variables.

Tab wiring - five edits, all required:
1. `AgentEditor/constants.ts` - append `{ key: "evals", labelKey: "editor.tabs.evals", icon: "FlaskConical" }`
2. `app/agents/[id]/page.tsx:15` - add `"evals"` to `VALID_TABS`, else `?tab=evals` silently falls back to `config`
3. `AgentEditor.tsx` - render the panel
4. the new `EvalsTab/` directory
5. `client/messages/en/agents.json` - `editor.tabs.evals`

### §5.4 Sidebar

`client/src/vendor/ui/nav.ts:41` - the item already exists as
`{ key: "eval", label: "Eval Dashboard", icon: "Target", href: "#", disabled: true }`.
Flip it to `href: "/eval-dashboard", gKey: "e"` and drop `disabled`. `activeKeyFor`
(`components/app-shell/helpers.ts:36`) already matches `/eval*` - no change there.

`src/vendor/` is a declared do-not-touch zone; this one-line edit is unavoidable for a
sidebar entry and **must be called out explicitly** in the final report so the
architecture review does not read it as an accident.

### §5.5 i18n

Single locale (`en`), no `[locale]` route segment. `client/messages/en/eval.json`
**already contains** the `dashboard`, `caseEditor`, `evalsTab` and `page` blocks - read
the file before inventing a key, and reuse an existing one wherever it fits.

Genuinely missing, and therefore to be added:
- `editor.tabs.evals` in `client/messages/en/agents.json`
- `finding.turnIntoEvalCase` in `client/messages/en/prReview.json`
- a `compare` block in `eval.json` for the comparison modal (title, the prompt-diff
  heading, the old/new legend, close)
- an `index` block in `eval.json` for the dashboard landing view (page title, subtitle,
  the agents heading, the cross-agent recent-runs heading)
- `expectation.mustFind` / `expectation.mustNotFlag` labels in `eval.json`

`client/messages/` is ordinary source, not `src/vendor/` - extending it is expected.
Add keys; do not rename or remove an existing one.

### §5.6 FindingCard

`FindingCard` is presentational and must stay that way - it already delegates via
`onAction`, and the mutation is wired one level up in `FindingsPanel`.

- "Turn into eval case" is **not** a `FindingActionKind`. Do not overload `onAction`.
  Add a separate optional prop `onCreateEvalCase?: () => void`.
- The button renders inside the existing `s.actions` row, after Dismiss,
  as `kind="ghost" size="sm" icon="FlaskConical"`.
- It is **disabled** when the finding has neither `accepted_at` nor `dismissed_at`,
  because the expectation kind is derived from that decision (4.4 step 2). The server
  returns 422 for the same case; the disabled state is UX, not the guard.
- The mutation is wired in `FindingsPanel` alongside `useFindingAction`.
- Which agent owns the created case: the agent that produced the finding's review
  (`reviews.agent_id`). The client passes only `finding_id`; the server resolves the
  owner. If that agent no longer exists -> 422.

---

## §6 Verification gate

`server/package.json` gains
`"verify:l06": "vitest run src/modules/eval/scoring.test.ts"`, beside the existing
`verify:l03`. Convention is one narrowly-scoped vitest file, no glob.

That file is a **pure unit test**: no DB, no testcontainers, no LLM, no network. It
imports the scorer from `@devdigest/reviewer-core` and asserts the full metric matrix of
section 3 - both expectation kinds, a hit, a miss, a false positive, the strict-precision
rule, every vacuous-denominator `null`, and citation accuracy from a `dropped` count. Its
hermeticity is itself the proof of the "scoring makes no LLM call" criterion.

There is **no lint script** in any package. The gate per package is `pnpm typecheck` +
`pnpm test`.

---

## §7 Out of scope for v1

- `owner_kind: 'skill'` eval cases (the schema permits them; no route serves them).
- The `evals/` package skill-eval (stretch item explicitly deferred by the user).
- Any change to `grounding.ts` in either package.
- Any change to the production review path (`modules/reviews/**`) beyond hoisting the
  patch-assembly helper into `modules/_shared/`.
