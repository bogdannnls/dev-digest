# Spec: Eval Pipeline | Spec ID: SPEC-03 | Status: draft
Supersedes: —
Modules: server, client, reviewer-core

## Problem & why

A review agent in DevDigest is a system prompt plus a model plus a set of linked skills.
Today there is no way to answer the only question that matters when any of those three
change: **did the agent get better or worse?** A user edits a prompt, re-runs a review on
one PR, eyeballs the findings, and forms an impression. That impression is not a
measurement, it is not reproducible, and it cannot be compared against last week's.

Most of the machinery to fix this is already in the repository and unused:

1. **`eval_cases` and `eval_runs` already exist** — `server/src/db/schema/eval.ts:7-35`,
   created by `0000_init.sql:116-127` — and no route reads or writes either table.
2. **The L06 API contracts already exist** — `server/src/vendor/shared/contracts/eval-ci.ts`
   ships `EvalCaseInput`, `EvalRunRecord`, `EvalRunResult`, `EvalTrendPoint` and
   `EvalDashboard`, all with zero consumers.
3. **The client copy already exists** — `client/messages/en/eval.json` already carries the
   dashboard, case-editor and Evals-tab strings, and `client/src/vendor/ui/nav.ts:41`
   already carries a disabled `Eval Dashboard` sidebar item pointing at `#`.
4. **The engine already supports offline replay** — `reviewPullRequest`
   (`reviewer-core/src/review/run.ts:123`) takes a pre-parsed `UnifiedDiff`, a system
   prompt, a model and an injected `LLMProvider`. It needs no PR, no repo and no clone.
   `AgentsService.evaluateSkillsAB` (`server/src/modules/agents/service.ts:258-296`)
   already drives it against a stored fixture diff for an A/B skills comparison — but that
   comparison is ephemeral: nothing is persisted, nothing is scored, and two of them
   cannot be compared later.

This feature turns that scattered scaffolding into one loop: a real review finding the
user already judged (accepted or dismissed) becomes a labelled eval case in one click;
all of an agent's cases form a set; the set is replayed against the current agent
configuration as a single **batch**; the batch is scored **deterministically, with zero
LLM calls**; and two batches can be put side by side to show what a prompt edit did to
recall and precision.

The frozen interface contract for this work is
[`docs/features/2026-08-25-eval-pipeline/contract.md`](../docs/features/2026-08-25-eval-pipeline/contract.md)
(v1.2, frozen 2026-08-25). This spec restates that contract as testable,
implementation-free acceptance criteria. Section references below (`§1.2`, `§3.3`, …)
point into it.

Three framing points that the design-analysis pass surfaced and that are decided, not
open:

1. **A set-run is a new entity, not a reinterpretation of `eval_runs`.** The shipped
   `eval_runs` schema is strictly per-case (`case_id NOT NULL`), and a run's system-prompt
   snapshot must be stored **once per run**, not duplicated onto every case row. Hence a
   new `eval_run_batches` table (§1.2) plus a nullable `batch_id` column on `eval_runs`
   (§1.3). See AC-1..AC-3.
2. **`precision` is strict: `TP / (all findings produced in the run)`** (§3.3). This is a
   deliberate choice with a known, accepted cost — see AC-41, Edge cases and
   Non-functional.
3. **The grounding gate is not touched.** `citation_accuracy` is computed from the
   `dropped[]` list the gate already exposes (`reviewer-core/src/review/run.ts:101`); no
   behaviour of `grounding.ts` in either package changes. It is a declared do-not-touch
   zone in both `server/CLAUDE.md` and `reviewer-core/CLAUDE.md`.

## Goals / Non-goals

**Goals**
- Turn a judged review finding into a labelled eval case in one click: an **accepted**
  finding becomes `must_find` ("the agent must report X at file:line"), a **dismissed**
  finding becomes `must_not_flag` ("the agent must not comment on Y").
- Give every agent one visible eval set, holding both finding-derived and hand-authored
  cases, backed by the already-shipped `eval_cases` table.
- Replay the whole set against the agent's current configuration as one persisted batch,
  with exactly one LLM call per case.
- Score every batch **deterministically in `reviewer-core`, with zero LLM calls**, into
  `recall`, `precision` and `citation_accuracy`.
- Keep a run history and let a user compare two runs of the same agent side by side,
  including the verbatim system prompt each one used, so "old prompt vs new prompt" is a
  measurement rather than a memory.
- Plot recall / precision / citation accuracy as a trend over all of an agent's runs.
- Provide a manual Case Editor (paste a diff, pick the expectation kind, name the file and
  the inclusive line range) whose cases land in the same set and execute through the same
  run route.
- Add one `PreToolUse` hook in `.claude/settings.json` that runs the package test gate
  before a commit is allowed.
- Ship `pnpm verify:l06` as a hermetic unit gate over the scorer — its hermeticity is the
  proof of the zero-LLM-calls property, not an assertion about it.

**Non-goals**
- No skill-eval package under `evals/` (explicitly deferred; §7).
- No `owner_kind: 'skill'` eval cases. The column permits them; no route in this feature
  serves them (§7).
- No change to `grounding.ts` in either package, and no change to the citation gate's
  behaviour (§7).
- No change to the production review path (`server/src/modules/reviews/**`) beyond hoisting
  the existing per-file patch-assembly helper into `server/src/modules/_shared/` so both
  `modules/reviews` and `modules/eval` can call one implementation.
- No new single-case run route and no single-case response shape — a single-case run is a
  batch of one (§4.1).
- No repository context in an eval run: `callers`, `repoMap`, `specs` and `prDescription`
  are deliberately withheld (§4.5). This is a known, intentional divergence from a
  production review, not a defect to be "fixed" later without a spec change.
- No LLM-assisted scoring, LLM-judged matching, or fuzzy path matching of any kind.
- No automatic re-run on prompt edit — a run is always user-initiated.
- No CI wiring of `verify:l06` into `.github/workflows/*` (path-filtered CI is a
  declared-intent zone in the root `CLAUDE.md`).

## User stories

- **US-1** — As a reviewer who accepted a finding, I turn it into a `must_find` eval case
  in one click, so that "the agent must keep catching this" becomes a permanent, checkable
  fact instead of a memory.
- **US-2** — As a reviewer who dismissed a finding, I turn it into a `must_not_flag` eval
  case in one click, so that a known false positive can never quietly come back.
- **US-3** — As an agent owner, I see every case in my agent's set in one list, whether it
  came from a finding or from the Case Editor, with its expectation kind, file and line
  range.
- **US-4** — As an agent owner, I run my agent over every case in the set with one action
  and get one persisted run back.
- **US-5** — As an agent owner, I see that run's recall, precision and citation accuracy,
  and I can tell "no data" apart from "scored zero".
- **US-6** — As an agent owner, I open the run history and compare two runs side by side,
  including the exact system prompt each used, so I can see what a prompt edit did to
  recall and precision.
- **US-7** — As an agent owner, I see recall / precision / citation accuracy plotted over
  all of my agent's runs, and I can reach that view from the sidebar.
- **US-8** — As an agent owner, I author a case by hand — paste a diff, pick the
  expectation kind, name the file and the inclusive line range — and it joins the same set
  and runs through the same route as the finding-derived cases.
- **US-9** — As a developer on this repo, a commit is blocked before it lands if the
  package test gate fails, so a red scorer never reaches history.
- **US-10** — As an operator, an eval run costs exactly one LLM call per case and scoring
  costs zero, so the price of a measurement is predictable and the score itself is
  reproducible.
- **US-11** — As an operator, the stored diff fragments and finding text that get replayed
  into a model prompt are treated as data, never as instructions.
- **US-12** — As an agent owner, one broken case (an unparseable diff, a provider error)
  costs me that case's result, not the whole run.

## Acceptance criteria (EARS)

**Data model**

- AC-1. The system shall persist one `eval_run_batches` row per set-run, carrying
  `workspace_id`, `owner_kind`, `owner_id`, `agent_version`, a verbatim `system_prompt`
  snapshot, `model`, `provider`, `ran_at`, `finished_at`, `status`, `cases_total`,
  `traces_passed`, `recall`, `precision`, `citation_accuracy`, `duration_ms`, `cost_usd`,
  `tokens_in`, `tokens_out` and `error` (§1.2). (traces: US-4, US-5, US-6) (verify:
  `server/test/eval-runs.it.test.ts` — new case asserting the inserted batch row exposes
  every listed column after a completed run)
- AC-2. The system shall keep every `eval_runs` row as exactly one case executed once —
  `case_id` stays `NOT NULL` — and shall set `batch_id` on every row this feature writes
  (§1.3). (traces: US-4) (verify: `server/test/eval-runs.it.test.ts` — new case: a batch
  over N cases yields exactly N `eval_runs` rows, all sharing one non-null `batch_id`)
- AC-3. The system shall introduce the schema change as migration
  `server/src/db/migrations/0018_eval_run_batches.sql` with a matching
  `{ "idx": 18, "tag": "0018_eval_run_batches" }` entry appended to
  `server/src/db/migrations/meta/_journal.json`, and shall not edit migrations 0000-0017
  (§1.4). (traces: US-4) (verify:
  `rg -n '"tag": "0018_eval_run_batches"' server/src/db/migrations/meta/_journal.json`
  returns a match, and `git diff --stat` shows no change to `0000`-`0017`; server-INSIGHTS
  2026-06-23 — a `.sql` without a journal entry is silently never applied)
- AC-4. The system shall write `'agent'` into `eval_cases.owner_kind` and the owning
  agent's id into `owner_id` for every case this feature creates, and shall leave
  `input_files` null (§1.1). (traces: US-1, US-2, US-8) (verify:
  `server/test/eval-cases.it.test.ts` — new case asserting `owner_kind = 'agent'` and
  `input_files IS NULL` on both a finding-derived and a manual case)

**Creating a case from a finding**

- AC-5. WHEN a case is requested from a finding whose `accepted_at` is non-null, the system
  shall create a case whose `expected_output.kind` is `must_find` (§4.4 step 2). (traces:
  US-1) (verify: `server/test/eval-cases.it.test.ts` — new case: accepted finding →
  201 with `expected_output.kind === 'must_find'`)
- AC-6. WHEN a case is requested from a finding whose `dismissed_at` is non-null, the
  system shall create a case whose `expected_output.kind` is `must_not_flag` (§4.4 step 2).
  (traces: US-2) (verify: same file — new case: dismissed finding → 201 with
  `expected_output.kind === 'must_not_flag'`)
- AC-7. IF a case is requested from a finding with neither `accepted_at` nor
  `dismissed_at`, THEN the system shall return 422 `ValidationError`
  ("finding has no accept/dismiss decision") and shall create no case — it shall never
  default an expectation kind (§4.4 step 2). (traces: US-1, US-2) (verify: same file — new
  case: undecided finding → 422, and `eval_cases` row count is unchanged)
- AC-8. The system shall populate `expected_output` from the finding as
  `{ kind, file, start_line, end_line, severity, category, title }`, where `severity`,
  `category` and `title` are display-only (§2.1, §4.4 step 3). (traces: US-1, US-2, US-3)
  (verify: `server/src/modules/eval/service.test.ts` — new case asserting the derived
  expectation equals the finding's file/line/severity/category/title by value)
- AC-9. WHEN deriving a case from a finding, the system shall assemble `input_diff` offline
  as a single-file fragment (`diff --git` / `---` / `+++` header followed by the stored
  patch) from the `pr_files.patch` row for the finding's file, issuing no GitHub call and
  performing no clone (§4.4 step 4). (traces: US-1, US-2, US-10) (verify:
  `server/test/eval-cases.it.test.ts` — new case using a `GitHubClient` and `GitClient`
  double that throws on any call; case creation still succeeds)
- AC-10. IF no `pr_files` row for the finding's path carries a non-null `patch`, THEN the
  system shall return 422 `ValidationError` ("no stored patch for <path>") and shall create
  no case (§4.4 step 4). (traces: US-1, US-2) (verify: same file — new case: finding whose
  file has a null patch → 422)
- AC-11. The system shall assign the created case to the agent that produced the finding's
  review (`reviews.agent_id`), resolving the owner server-side from the `finding_id` alone
  (§5.6). (traces: US-1, US-2) (verify: `server/src/modules/eval/service.test.ts` — new
  case asserting `owner_id` equals the review's `agent_id`, with no owner in the request
  body)
- AC-12. IF the agent that produced the finding's review no longer exists, THEN the system
  shall return 422 and shall create no case (§5.6). (traces: US-1, US-2) (verify:
  `server/test/eval-cases.it.test.ts` — new case: finding whose review's agent was deleted
  → 422)
- AC-13. The system shall derive the case `name` as a slug of the finding title,
  de-duplicating within the owner by appending `-2`, `-3` and so on (§4.4 step 5).
  (traces: US-1, US-2, US-3) (verify: `server/src/modules/eval/service.test.ts` — new case:
  two findings with the same title yield `<slug>` and `<slug>-2`)
- AC-14. The system shall set `input_meta` to
  `{ origin: 'finding', source_finding_id, source_pr_id, source_review_id }` on every
  finding-derived case (§2.2, §4.4 step 6). (traces: US-1, US-2) (verify:
  `server/test/eval-cases.it.test.ts` — new case asserting all four `input_meta` fields on
  the created row)
- AC-15. IF a case with the same `source_finding_id` already exists for the agent, THEN the
  system shall return that existing case with 200 rather than creating a duplicate (§4.4
  step 7). (traces: US-1, US-2) (verify: same file — new case: the same
  `POST .../eval-cases/from-finding` twice → 201 then 200 with an identical `id`, and one
  row in `eval_cases`)

**The Case Editor and the shared set**

- AC-16. WHEN a manual case is submitted with `name`, `input_diff`, an `EvalExpectation`
  and optional `notes`, the system shall create a case in the same `eval_cases` set with
  `input_meta.origin = 'manual'` (§2.3, §4.2). (traces: US-8) (verify:
  `server/test/eval-cases.it.test.ts` — new case: `POST /agents/:id/eval-cases` → 201 with
  `input_meta.origin === 'manual'`)
- AC-17. IF a submitted expectation has `end_line < start_line`, THEN the system shall
  return 422 and shall create no case (§2.1 refinement). (traces: US-8) (verify:
  `server/test/eval-cases.it.test.ts` — new case: `start_line: 10, end_line: 4` → 422)
- AC-18. IF a submitted manual case has an empty `input_diff` or an empty `name`, THEN the
  system shall return 422 and shall create no case (§2.3). (traces: US-8) (verify: same
  file — new case: `input_diff: ""` → 422; `name: ""` → 422)
- AC-19. The system shall hold finding-derived and manual cases in one set per agent and
  shall execute both kinds through the same run route — no per-origin table, no per-origin
  route (§4.1, §4.2). (traces: US-3, US-8) (verify: `server/test/eval-runs.it.test.ts` —
  new case: an agent with one finding-derived and one manual case runs both in one batch,
  producing two `eval_runs` rows under one `batch_id`)
- AC-20. WHEN `GET /agents/:id/eval-cases` is requested, the system shall return that
  agent's cases ordered by `name` ascending, with `expected_output` typed as
  `EvalExpectation` (§1.1, §4.2). (traces: US-3) (verify: same file — new case: three
  cases inserted out of order are returned name-ascending)
- AC-21. WHEN `PUT /agents/:id/eval-cases/:caseId` is received, the system shall replace
  that case's `name`, `input_diff`, `expected_output` and `notes` and return the updated
  case (§4.2). (traces: US-8) (verify: same file — new case: PUT changes the expectation
  kind, and the subsequent GET reflects it)
- AC-22. WHEN `DELETE /agents/:id/eval-cases/:caseId` is received, the system shall remove
  the case and return 204 (§4.2). (traces: US-8) (verify: same file — new case: DELETE →
  204, and the case is absent from the subsequent GET)

**Running a set**

- AC-23. WHEN `POST /agents/:id/eval-runs` is received without `case_ids`, the system shall
  execute every case in that agent's set inside one batch and write exactly one `eval_runs`
  row per case, so an agent whose set holds at least 8 cases yields `cases_total >= 8` and
  at least 8 rows for that `batch_id` (§4.1). (traces: US-4) (verify:
  `server/test/eval-runs.it.test.ts` — new case: an agent seeded with 8 cases (mixed
  `must_find` / `must_not_flag`) runs to `cases_total === 8` with 8 `eval_runs` rows)
- AC-24. WHERE `case_ids` is present in the request body, the system shall execute exactly
  that subset as a batch of its own, using the same route and the same response shape as a
  full-set run (§4.1). (traces: US-4) (verify: same file — new case: `case_ids` with one id
  → a batch with `cases_total === 1`)
- AC-25. IF the target agent has zero eval cases, THEN the system shall return 422
  `ValidationError` ("agent has no eval cases") and shall create no batch row (§4.1).
  (traces: US-4) (verify: same file — new case: agent with no cases → 422, and
  `eval_run_batches` is empty)
- AC-26. IF the agent id, or a `batchId` in the path, does not resolve within the caller's
  workspace, THEN the system shall return 404 (§4.1). (traces: US-4, US-6) (verify: same
  file — new cases: unknown agent id → 404; unknown batch id → 404)
- AC-27. The system shall invoke `reviewPullRequest` exactly once per case, sequentially,
  so a batch over N cases costs exactly N LLM calls (§4.5). (traces: US-4, US-10) (verify:
  `server/src/modules/eval/service.test.ts` — new case with a counting `LLMProvider`
  double asserting the call count equals the case count, and that calls do not overlap)
- AC-28. The system shall pass only `systemPrompt`, `model`, the parsed diff, the injected
  `llm`, `strategy`, the enabled `skills` bodies, `task` and `sessionId` into
  `reviewPullRequest`, and shall pass no `callers`, `repoMap`, `specs` or `prDescription`
  (§4.5). (traces: US-4, US-10) (verify: `server/src/modules/eval/service.test.ts` — new
  case asserting the captured `ReviewInput` has no `callers`, `repoMap`, `specs` or
  `prDescription` key, mirroring `server/test/skills-eval.it.test.ts:175`)
- AC-29. WHEN a batch is created, the system shall snapshot the agent's `system_prompt`
  verbatim and its `version` onto the batch row, once per batch (§1.2). (traces: US-6)
  (verify: `server/test/eval-runs.it.test.ts` — new case asserting
  `batch.system_prompt === agent.systemPrompt` byte-for-byte and
  `agent_version === agent.version`)
- AC-30. WHERE the agent has enabled linked skills, the system shall include their bodies
  in every case's review call, so that relinking a skill changes subsequent batch metrics
  (§4.5). (traces: US-6) (verify: `server/src/modules/eval/service.test.ts` — new case: an
  agent with one enabled skill yields a `ReviewInput.skills` array containing that body;
  disabling it removes the key)
- AC-31. The system shall parse `input_diff` with `parseUnifiedDiff` before the review call
  and shall never send a raw unparsed diff string to the engine (§4.5). (traces: US-4)
  (verify: `server/src/modules/eval/service.test.ts` — new case asserting the captured
  `ReviewInput.diff` is a `UnifiedDiff` object, not a string)

**Per-case failure isolation**

- AC-32. IF a case's `input_diff` parses to zero files, THEN the system shall record that
  case with `pass = false` and
  `actual_output = { error: 'diff fragment parsed to zero files' }` and shall continue the
  batch (§4.6). (traces: US-12) (verify: `server/test/eval-runs.it.test.ts` — new case: a
  batch of two where one case's diff is a bare `@@` fragment; both rows exist, the bad one
  carries the error, the good one is scored)
- AC-33. IF the provider errors on a case, THEN the system shall record that case with
  `pass = false` and `actual_output = { error: <message> }` and shall continue the batch
  (§4.6). (traces: US-12) (verify: same file — new case: an `LLMProvider` double that
  throws on the second of three cases; all three rows exist and the batch completes)
- AC-34. The system shall count a failed case in `cases_total` and `traces_total`,
  contribute none of its findings to any metric, and treat its `must_find` expectation as
  missed for `recall` (§4.6). (traces: US-12, US-5) (verify:
  `reviewer-core/src/eval/score.test.ts` — new case: a two-case batch where one
  `must_find` case errored scores `recall = 0.5`, not `1`)
- AC-35. IF every case in a batch errored, THEN the system shall set the batch `status` to
  `'failed'` (§4.6). (traces: US-12) (verify: `server/test/eval-runs.it.test.ts` — new
  case: a provider double that always throws → `status === 'failed'`)
- AC-36. WHILE at least one case in a finished batch completed without error, the system
  shall set that batch's `status` to `'succeeded'` (§4.6). (traces: US-12) (verify: same
  file — new case: one of three cases errors → `status === 'succeeded'`)

**Scoring — deterministic, zero LLM calls**

- AC-37. The system shall implement scoring as a pure function in
  `reviewer-core/src/eval/score.ts`, exported from `reviewer-core/src/index.ts`, containing
  no `fs`, no `fetch`, no `process.env` read and no import from `reviewer-core/src/llm/**`
  — so a score is structurally incapable of making an LLM call (§3). (traces: US-10)
  (verify: `rg -n "from '.*llm|require\('fs|fetch\(|process\.env" reviewer-core/src/eval/score.ts`
  returns no matches, and `cd server && pnpm verify:l06` passes with the network
  unavailable)
- AC-38. The system shall consider a finding to match an expectation when the normalized
  file paths are equal and the two inclusive line ranges overlap, where normalization
  strips a single leading `./` and trims whitespace and does nothing else — no basename
  fallback, no case folding, no fuzzy path matching (§3.1). (traces: US-5) (verify:
  `reviewer-core/src/eval/score.test.ts` — new cases: `./a/b.ts` matches `a/b.ts`;
  `src/b.ts` does not match `lib/b.ts`; `A.ts` does not match `a.ts`; ranges `[5,7]` and
  `[7,9]` overlap; `[5,6]` and `[7,9]` do not)
- AC-39. WHEN a `must_find` case produces at least one matching finding, the system shall
  credit the **first** matching finding in returned order as that case's single true
  positive and set `pass = true` (§3.2). (traces: US-1, US-5) (verify:
  `reviewer-core/src/eval/score.test.ts` — new case: two matching findings yield exactly
  one true positive and `pass === true`)
- AC-40. IF a `must_find` case produces no matching finding, THEN the system shall set
  `pass = false` and count every finding that case produced as a false positive (§3.2).
  (traces: US-1, US-5) (verify: same file — new case: a `must_find` case with two
  non-matching findings scores `pass === false` and contributes 0 TP and 2 findings to `F`)
- AC-41. The system shall compute `precision` as `TP / F`, where `F` is the total count of
  post-grounding findings produced across every case in the batch — so a finding that the
  dataset does not positively vouch for lowers precision even when it is a genuine bug
  (§3.3). (traces: US-5, US-6) (verify: `reviewer-core/src/eval/score.test.ts` — new case:
  one `must_find` case that emits the expected finding plus one extra, unexpected finding
  scores `precision === 0.5` and `recall === 1`)
- AC-42. The system shall compute `recall` as `TP / MF`, where `MF` is the number of
  `must_find` cases in the batch (§3.3). (traces: US-5) (verify: same file — new case: 3
  `must_find` cases, 2 satisfied, plus 2 `must_not_flag` cases → `recall === 2/3`)
- AC-43. WHEN a `must_not_flag` case produces no matching finding, the system shall set
  `pass = true` for that case (§3.2). (traces: US-2, US-5) (verify: same file — new case: a
  `must_not_flag` case whose findings are all in another file scores `pass === true`)
- AC-44. IF a `must_not_flag` case produces at least one matching finding, THEN the system
  shall set `pass = false` for that case (§3.2). (traces: US-2, US-5) (verify: same file —
  new case: a `must_not_flag` case with an in-range finding scores `pass === false`)
- AC-45. The system shall count every finding produced by a `must_not_flag` case as a false
  positive and shall never credit such a case with a true positive (§3.2). (traces: US-2,
  US-5) (verify: same file — new case: a `must_not_flag` case emitting one non-matching
  finding contributes 0 TP and 1 to `F`, so a batch of only that case scores
  `precision === 0`)
- AC-46. The system shall compute `citation_accuracy` as `kept / (kept + dropped)`, where
  `kept` sums `outcome.review.findings.length` and `dropped` sums `outcome.dropped.length`
  across the batch, without altering the grounding gate (§3.3). (traces: US-5) (verify:
  `reviewer-core/src/eval/score.test.ts` — new case: a batch with 3 kept and 1 dropped
  scores `citation_accuracy === 0.75`; plus
  `git diff --stat` shows no change to `reviewer-core/src/grounding.ts` or
  `server/src/platform/grounding.ts`)
- AC-47. The system shall set `traces_passed` to the number of cases with `pass = true` and
  `traces_total` to `cases_total` (§3.3). (traces: US-5) (verify: same file — new case: 5
  cases, 3 passing → `traces_passed === 3`, `traces_total === 5`)
- AC-48. The system shall read only `kind`, `file`, `start_line` and `end_line` from an
  expectation when scoring, and shall never read `severity`, `category` or `title` (§2.1).
  (traces: US-5) (verify: `rg -n "severity|category|\.title" reviewer-core/src/eval/score.ts`
  returns no matches; plus a `score.test.ts` case where two otherwise-identical
  expectations with different severities score identically)
- AC-49. IF `MF` is zero, THEN the system shall report `recall` as `null` — never `0` and
  never `1` (§3.4). (traces: US-5) (verify: `reviewer-core/src/eval/score.test.ts` — new
  case: a batch of only `must_not_flag` cases scores `recall === null`)
- AC-50. IF `F` is zero, THEN the system shall report `precision` as `null` — never `0` and
  never `1` (§3.4). (traces: US-5) (verify: same file — new case: a batch where no case
  produced any finding scores `precision === null`)
- AC-51. IF `kept + dropped` is zero, THEN the system shall report `citation_accuracy` as
  `null` — never `0` and never `1` (§3.4). (traces: US-5) (verify: same file — new case: a
  batch with no findings and no drops scores `citation_accuracy === null`)
- AC-52. The system shall keep `pass` and `precision` as independent measures: a
  `must_find` case that emits the expected finding alongside noise shall pass while its
  noise still lowers batch precision (§3.3). (traces: US-5) (verify: same file — new case:
  asserts `pass === true` and `precision < 1` in the same batch)

**Run history and comparison**

- AC-53. WHEN `GET /agents/:id/eval-runs` is requested, the system shall return that
  agent's batches newest-first with a default limit of 20 and a `?limit=` capped at 100
  (§4.1). (traces: US-6) (verify: `server/test/eval-runs.it.test.ts` — new cases: 25
  batches → 20 returned, newest first; `?limit=500` → at most 100)
- AC-54. WHEN `GET /agents/:id/eval-runs/compare?a=&b=` is requested, the system shall
  return both `EvalBatchRecord`s, both verbatim system prompts, and
  `delta.X = b.X - a.X` for `recall`, `precision`, `citation_accuracy` and `cost_usd`
  (§2.6). (traces: US-6) (verify: same file — new case asserting each delta equals the
  arithmetic difference of the two batch rows)
- AC-55. IF either side of a delta is `null`, THEN the system shall report that delta field
  as `null` (§2.6). (traces: US-5, US-6) (verify: same file — new case: comparing a batch
  with `precision === null` against one with `precision === 0.5` yields
  `delta.precision === null`)
- AC-56. IF `a.ran_at` is later than `b.ran_at`, THEN the system shall swap the two so that
  `a` is always the older run (§4.1). (traces: US-6) (verify: same file — new case: query
  with the newer id in `a` returns the older batch in the `a` slot)
- AC-57. IF either `a` or `b` does not belong to the agent named in the path, THEN the
  system shall return 404 (§4.1). (traces: US-6) (verify: same file — new case: a batch id
  from another agent → 404)
- AC-58. The system shall ship both system prompts verbatim in the comparison response and
  shall compute no textual diff server-side; the client renders the diff (§2.6). (traces:
  US-6) (verify:
  `rg -n "diffLines|createPatch|structuredPatch|jsdiff" server/src/modules/eval/` returns no
  matches, and `EvalRunComparison` in `server/src/vendor/shared/contracts/eval-ci.ts`
  contains no diff field)
- AC-59. The system shall omit `system_prompt` from `EvalBatchRecord`, carrying it only in
  `EvalBatchDetail` and `EvalRunComparison`, so a runs list never ships dozens of
  multi-kilobyte prompts (§2.4). (traces: US-6, US-7) (verify:
  `server/src/vendor/shared/contracts/eval-ci.test.ts` — new case:
  `EvalBatchRecord.parse` on an object containing `system_prompt` yields a parsed value
  with no `system_prompt` key)
- AC-60. WHEN two batches of the same agent are run over the same case set under different
  `system_prompt` snapshots and the two runs produce different finding sets, the system
  shall report different `recall` and/or `precision` on the two batch rows and non-zero
  corresponding deltas from the compare route (§2.6, §3.3). (traces: US-6) (verify:
  `server/test/eval-runs.it.test.ts` — new case: an `LLMProvider` double keyed on the
  system prompt returns the expected finding for prompt A and a non-matching finding for
  prompt B; asserts `recallA > recallB` and `delta.recall !== 0`)

**Dashboard and trend**

- AC-61. WHEN `GET /eval-dashboard` is requested, the system shall return one
  `EvalDashboardAgentSummary` per agent — `agent_id`, `agent_name`, `model`, `cases_total`,
  `last_run` and `trend` — plus `recent_runs` as `EvalBatchRecord`s each carrying
  `agent_name` (§2.7, §4.3). (traces: US-7) (verify:
  `server/test/eval-dashboard.it.test.ts` — new case asserting the response parses against
  `EvalDashboardIndex` with two agents present)
- AC-62. The system shall type `EvalDashboard.recent_runs` as an array of
  `EvalBatchRecord` (per run), not `EvalRunRecord` (per case) (§2.8). (traces: US-7)
  (verify: `server/src/vendor/shared/contracts/eval-ci.test.ts` — new case:
  `EvalDashboard.parse` rejects a `recent_runs` element shaped as a per-case
  `EvalRunRecord` that lacks `cases_total`)
- AC-63. IF a batch carries a `null` `recall`, `precision` or `citation_accuracy`, THEN the
  system shall omit that batch from the trend series rather than coerce the metric to a
  number (§3.4). (traces: US-5, US-7) (verify: `server/test/eval-dashboard.it.test.ts` —
  new case: 3 batches of which one has `precision === null` → `trend.length === 2`)
- AC-64. WHEN `GET /eval-dashboard/:agentId` is requested for an agent with at least one
  batch, the system shall populate `current` from that agent's newest batch verbatim,
  propagating a `null` metric as `null` rather than coercing it to a number (§4.3, and the
  v1.3 ruling in §2.8 which widens `EvalDashboard.current` and `EvalDashboard.delta` to
  nullable).
  (traces: US-5, US-7) (verify: `server/test/eval-dashboard.it.test.ts` — new case
  asserting `current` mirrors the newest batch's non-null metrics field-for-field; the
  null-metric case is added once Q1 is resolved)
- AC-65. WHEN `GET /eval-dashboard/:agentId` is requested, the system shall compute `delta`
  as newest-minus-previous, and shall return `null` for a metric when there is no previous
  run or when either side's metric is `null` (§4.3, contract v1.3). (traces: US-7)
  (verify: same file — new cases: a single batch → all deltas `null`; a previous batch with
  `recall === null` → `delta.recall === null`)
- AC-66. IF any of `recall`, `precision` or `citation_accuracy` moved down by at least 0.02
  between the two newest batches, THEN the system shall return `alert` as a one-line string
  naming the regression (§4.3). (traces: US-7) (verify: same file — new case: recall 0.90 →
  0.87 yields a non-null single-line `alert`)
- AC-67. WHILE no metric moved down by at least 0.02 between the two newest batches, the
  system shall return `alert` as `null` (§4.3). (traces: US-7) (verify: same file — new
  case: recall 0.90 → 0.895 yields `alert === null`)

**Client surfaces**

- AC-68. WHEN a finding carries either an `accepted_at` or a `dismissed_at`, the client
  shall render a "Turn into eval case" ghost button in `FindingCard`'s existing actions row
  after Dismiss (§5.6). (traces: US-1, US-2) (verify:
  `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.test.tsx`
  — new case: an accepted finding renders an enabled "Turn into eval case" control)
- AC-69. IF a finding has neither `accepted_at` nor `dismissed_at`, THEN the client shall
  render that button disabled (§5.6). (traces: US-1, US-2) (verify: same file — new case:
  an undecided finding renders the control with `disabled` set)
- AC-70. The client shall expose the action as a distinct optional `onCreateEvalCase` prop
  and shall not add a member to `FindingActionKind` or overload `onAction`, keeping
  `FindingCard` presentational with the mutation wired one level up in `FindingsPanel`
  (§5.6). (traces: US-1, US-2) (verify:
  `rg -n "eval" client/src/vendor/shared/contracts/findings.ts` returns no match on
  `FindingActionKind`, and
  `rg -n "useMutation|api\." client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/FindingCard/`
  returns no matches)
- AC-71. WHEN the Evals tab is opened for an agent, the client shall list every case in the
  agent's set with its expectation kind, file and inclusive line range (§5.3). (traces:
  US-3) (verify:
  `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/EvalsTab.test.tsx`
  — new case: a mocked two-case response renders both names, kinds and `file:start-end`
  labels)
- AC-72. WHEN the agent page is opened with `?tab=evals`, the client shall show the Evals
  tab rather than falling back to the config tab (§5.3). (traces: US-3) (verify:
  `rg -n '"evals"' client/src/app/agents/\[id\]/page.tsx` shows `evals` inside
  `VALID_TABS`; plus an `AgentEditor.test.tsx` case asserting the Evals panel renders for
  that tab value)
- AC-73. The client shall render a `null` metric as an em dash in `EvalMetricTiles`, so
  "no data" is visually distinct from a scored `0` (§5.2, §3.4). (traces: US-5) (verify:
  `client/src/components/eval/EvalMetricTiles/EvalMetricTiles.test.tsx` — new cases:
  `precision: null` renders `—`; `precision: 0` renders `0%`)
- AC-74. WHEN two runs are selected in the runs table, the client shall open the comparison
  modal showing both runs' metrics side by side and the diff between their two system
  prompts (§5.2, §2.6). (traces: US-6) (verify:
  `client/src/components/eval/EvalRunComparison/EvalRunComparison.test.tsx` — new case:
  two mocked batches with different prompts render both metric columns and a visible
  prompt-diff region)
- AC-75. WHERE the Case Editor modal is open, the client shall accept a pasted diff, an
  expectation kind, a file path and a start/end line range, and on save the new case shall
  appear in the same Evals-tab list as the finding-derived cases (§5.3, §2.3). (traces:
  US-8) (verify:
  `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/_components/EvalCaseModal/EvalCaseModal.test.tsx`
  — new case: filling the form and saving issues one `POST /agents/:id/eval-cases` and the
  list query is invalidated)
- AC-76. WHEN the Eval Dashboard page is opened, the client shall plot `recall`,
  `precision` and `citation_accuracy` for all of an agent's runs in chronological order
  (§2.7, §5.3). (traces: US-7) (verify:
  `client/src/app/eval-dashboard/_components/EvalDashboardView/EvalDashboardView.test.tsx`
  — new case: a four-point mocked trend renders three series in `ran_at` order)
- AC-77. The client shall enable the existing `Eval Dashboard` sidebar item, pointing it at
  `/eval-dashboard` with `gKey: "e"` and no `disabled` flag (§5.4). (traces: US-7) (verify:
  `rg -n 'key: "eval"' client/src/vendor/ui/nav.ts` shows `href: "/eval-dashboard"` and no
  `disabled`; this is a deliberate one-line edit inside the declared do-not-touch
  `src/vendor/` zone and must be called out in the implementation report)
- AC-78. The client shall reach every eval endpoint through `client/src/lib/api.ts` via
  hooks in `client/src/lib/hooks/eval.ts`, validating each response with the Zod contract's
  `.parse()` (§5.1). (traces: US-3, US-4, US-5, US-6, US-7, US-8) (verify:
  `rg -n "fetch\(|api\." client/src/components/eval/ client/src/app/eval-dashboard/`
  returns no matches, and `client/src/lib/hooks/eval.test.ts` — new case asserting a
  malformed response rejects rather than reaching the component)
- AC-79. The system shall mirror every `contracts/eval-ci.ts` addition byte-for-byte
  between `server/src/vendor/shared/contracts/eval-ci.ts` and
  `client/src/vendor/shared/contracts/eval-ci.ts` (§2). (traces: US-3, US-4, US-5, US-6,
  US-7, US-8) (verify:
  `diff server/src/vendor/shared/contracts/eval-ci.ts client/src/vendor/shared/contracts/eval-ci.ts`
  exits 0; server-INSIGHTS 2026-06-23 — the two vendor trees are manually synced copies)
- AC-80. The client shall source all new user-facing eval copy from the message
  catalogue, reusing the existing `dashboard`, `caseEditor`, `evalsTab` and `page` blocks
  of `client/messages/en/eval.json` and adding exactly five things: `editor.tabs.evals` in
  `agents.json`, `finding.turnIntoEvalCase` in `prReview.json`, and a `compare` block, an
  `index` block and `expectation.mustFind` / `expectation.mustNotFlag` labels in
  `eval.json` — renaming or removing no existing key (§5.5). (traces: US-1, US-3, US-6,
  US-7) (verify: `rg -n "turnIntoEvalCase" client/messages/en/prReview.json`,
  `rg -n "evals" client/messages/en/agents.json` and
  `rg -n '"compare"|"index"|mustNotFlag' client/messages/en/eval.json` all match;
  `git diff client/messages/en/eval.json` shows additions only; and no hardcoded English
  literal appears in the new `EvalsTab` / `EvalDashboardView` / `EvalRunComparison` render
  output)

**Verification gate**

- AC-81. The system shall expose
  `"verify:l06": "vitest run src/modules/eval/scoring.test.ts"` in `server/package.json`,
  beside the existing `verify:l03`, as a single narrowly-scoped file with no glob (§6).
  (traces: US-9, US-10) (verify: `rg -n '"verify:l06"' server/package.json` matches, and
  `cd server && pnpm verify:l06` exits 0)
- AC-82. The system shall keep `server/src/modules/eval/scoring.test.ts` hermetic — no DB,
  no testcontainers, no LLM, no network — asserting both expectation kinds, a hit, a miss,
  a false positive, the strict-precision rule, all three vacuous-denominator `null`s, and
  citation accuracy from a `dropped` count (§6). (traces: US-9, US-10) (verify: the file
  does not end in `.it.test.ts` and does not import `test/helpers/pg.ts`:
  `rg -n "helpers/pg|testcontainers|fetch\(" server/src/modules/eval/scoring.test.ts`
  returns no matches, and `cd server && pnpm verify:l06` exits 0 with the network
  unavailable)
- AC-83. WHEN a `git commit` command is about to be issued through the agent harness, the
  `PreToolUse` hook registered in `.claude/settings.json` shall run the package test gate
  before the command executes. (traces: US-9) (verify:
  `rg -n "PreToolUse" .claude/settings.json` matches a `Bash` matcher whose command
  invokes the gate script; plus a dry run of the hook script against a clean tree exits 0)
- AC-84. IF the test gate exits non-zero, THEN the `PreToolUse` hook shall deny the commit
  and emit a message naming the failing command. (traces: US-9) (verify: run the hook
  script with a deliberately failing gate command injected via its environment; assert a
  non-zero/deny result whose stderr contains the failing command string)

**Untrusted inputs**

- AC-85. The system shall wrap every stored `input_diff` fragment and every expectation
  `title` replayed into a review prompt as untrusted background content carrying an
  explicit instruction never to follow directives embedded within it. (traces: US-11)
  (verify: `rg -n "untrusted" reviewer-core/src/prompt.ts` returns a match covering the
  diff body; plus `server/src/modules/eval/service.test.ts` — new case asserting the case
  `name`/`title` reaches the model only inside the `task` field's untrusted-labelled
  wrapper)
- AC-86. WHEN the client renders a case's stored `input_diff`, `name`, `notes` or
  expectation `title`, it shall render them as text and never as executable markup.
  (traces: US-11) (verify:
  `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/EvalsTab.test.tsx`
  — new case: a case named `<img src=x onerror=alert(1)>` renders as literal text, and
  `rg -n "dangerouslySetInnerHTML" client/src/components/eval/ client/src/app/eval-dashboard/`
  returns no matches)

**Landed scorer API (contract §3.5, added in contract v1.2)**

- AC-87. The system shall expose the scorer as `matches`, `scoreCase` and `scoreBatch`
  from `reviewer-core/src/eval/score.ts`, re-exported from `reviewer-core/src/index.ts`,
  with `scoreBatch` returning `{ recall, precision, citation_accuracy, traces_passed,
  traces_total }` and `scoreCase` returning
  `{ pass, matchedFindingId, truePositives, falsePositives }` (§3.5). (traces: US-5,
  US-10) (verify:
  `rg -n "export (function|const) (matches|scoreCase|scoreBatch)" reviewer-core/src/eval/score.ts`
  returns three matches, and `rg -n "eval/score" reviewer-core/src/index.ts` returns a
  re-export)
- AC-88. The system shall set `matchedFindingId` to the id of the **first** finding
  satisfying `matches` for both expectation kinds — the credited true positive on a
  `must_find` case, the offending finding on a failing `must_not_flag` case — and to
  `null` when no finding matches, persisting it unchanged into
  `actual_output.matched_finding_id` (§3.5, §4.7). (traces: US-2, US-5) (verify:
  `reviewer-core/src/eval/score.test.ts` — new cases: a failing `must_not_flag` case
  reports the offending finding's id; a passing `must_not_flag` case reports `null`; plus
  `server/test/eval-runs.it.test.ts` asserting the persisted
  `actual_output.matched_finding_id` equals the scorer's value)

## Edge cases

- **A `must_find` case's diff contains a second, genuinely new bug.** Under strict
  precision (AC-41), that second finding is counted in `F` but earns no `TP`, so it lowers
  `precision`. This is the accepted cost of the strict definition, not a scoring bug: the
  dataset only vouches for what it labelled, and a metric that silently forgave unlabelled
  findings could not detect prompt noise — which is the entire point of the experiment. The
  mitigation is a dataset one: label the second bug as its own `must_find` case.
- **A batch whose set contains only `must_not_flag` cases.** `MF == 0`, so `recall` is
  `null` (AC-49), and the batch is dropped from the trend series (AC-63). It is still a
  legitimate run with a meaningful `precision` and `citation_accuracy`.
- **A batch where the agent produced no findings at all.** `F == 0`, so `precision` is
  `null` (AC-50) even though `recall` may legitimately be `0`. A "silent" agent must not
  read as a perfect-precision agent.
- **A batch where no finding survived and none was dropped.** `kept + dropped == 0`, so
  `citation_accuracy` is `null` (AC-51) — distinct from a gate that dropped everything,
  which scores `0`.
- **Two findings in one `must_find` case both match.** Only the first in returned order is
  the true positive (AC-39); the second counts against precision. A case can never score
  more than one `TP`.
- **A `must_not_flag` case that produces findings elsewhere in the file range.** It passes
  (AC-43) but every finding it produced still counts in `F` (AC-45) — so a noisy prompt is
  penalised even on the cases it "passes".
- **Re-clicking "Turn into eval case" on the same finding.** Idempotent: the existing case
  is returned with 200, not duplicated (AC-15). A double-click therefore cannot inflate
  `cases_total`.
- **A finding whose file has no stored patch** (for example, a binary file, or a PR synced
  before per-file patches were persisted). 422 with a specific message (AC-10) — never a
  case with an empty diff that would silently score as a zero-file parse at run time.
- **A diff fragment starting bare at `@@` with no `+++` line.** `parseUnifiedDiff` yields
  `path: ''` and filters the file out, so the fragment parses to zero files; the case is
  recorded as failed and the batch continues (AC-32). This is the most likely Case Editor
  paste error and must produce a per-case error, not a 500.
- **An agent deleted between case creation and a run.** Cases cascade from
  `workspace_id`, not from the agent, so orphan cases are reachable by owner id only. The
  run route resolves the agent first and 404s (AC-26) rather than running against a null
  prompt.
- **A prompt edited mid-batch.** The snapshot is taken once when the batch is created
  (AC-29), so every case in a batch is scored against one prompt. A concurrent edit affects
  the next batch, never the running one.
- **Two batches started concurrently for the same agent.** Both are legal: each gets its
  own `batch_id`, its own snapshot and its own metrics. Nothing in this feature serialises
  runs per agent — the sequential constraint (AC-27) is *within* a batch only.
- **A `?limit=` above 100 or below 1.** Capped at 100 (AC-53); a non-positive value is
  rejected by the route's Zod schema as 422, per the server's boundary-validation
  convention.
- **A very long system prompt.** Excluded from `EvalBatchRecord` (AC-59), so a 20-row runs
  table does not ship 20 multi-kilobyte prompts; it is fetched only when a detail view or a
  comparison needs it.
- **Comparing a batch against itself.** `a === b` produces all-zero deltas and two
  identical prompts. Not an error — a degenerate but well-defined answer.

## Non-functional

- **Cost.** An eval run costs exactly `N` LLM calls for `N` cases (AC-27) — no retry
  amplification beyond the engine's own existing resilience, no scoring calls (AC-37), no
  second pass. With the demo set at 8 cases, one run is 8 calls. Because runs are
  user-initiated only and never triggered by a prompt edit, the cost ceiling is directly
  under the user's hand. Per-batch `cost_usd`, `tokens_in` and `tokens_out` are persisted
  (AC-1) so the price of the measurement is itself auditable.
- **Determinism of scoring.** The score of a batch is a pure function of the persisted
  per-case findings and expectations (AC-37, AC-38). Re-scoring a stored batch must produce
  the same numbers forever; only the *review* step is non-deterministic. This is what makes
  two runs comparable at all.
- **Honest metrics over flattering metrics.** Strict precision (AC-41) is deliberately
  unforgiving, and vacuous denominators yield `null` rather than a convenient `0` or `1`
  (AC-49..AC-51). Both choices trade a nicer-looking dashboard for a metric that actually
  moves when the agent gets worse. A `null` is rendered as an em dash (AC-73), never as a
  number the user might average.
- **Performance.** Cases run sequentially (AC-27) because provider rate limits preclude
  parallelism — the same constraint `evaluateSkillsAB` already lives under. An 8-case run
  therefore takes roughly eight review latencies end to end. No SLA is set; the POST is
  synchronous and the client must show a running state for the duration. If set sizes grow
  past a few dozen cases, moving the batch behind the existing job/SSE machinery is the
  obvious follow-up — out of scope here.
- **Security.** No new outbound network surface: case creation is fully offline from
  `pr_files.patch` (AC-9), and a run's only egress is the already-configured LLM provider.
  Every route resolves `workspaceId` from the request context before touching data, so
  cross-workspace batch or case ids resolve to 404 (AC-26, AC-57) rather than leaking
  existence. Stored diffs and finding titles are replayed into a prompt and are treated as
  untrusted data (AC-85, AC-86) — see the next section.
- **Observability.** Every batch persists its status, error, timing, token and cost
  columns (AC-1), and every case persists its own `actual_output` including the grounding
  summary and dropped count (§4.7), so a metric regression can be traced down to the exact
  case and finding that caused it without re-running anything.
- **Accessibility.** The runs table follows the existing grid-based table convention (there
  is no `<table>` in `src/app`), so selection checkboxes must carry accessible names and
  the comparison modal must use the existing `Modal` primitive's focus trap rather than a
  bare overlay div.
- **Internationalization.** Single locale (`en`). All new copy comes from the existing
  `client/messages/en/eval.json` plus the two missing keys (AC-80) — no hardcoded English
  literals in the new components.

## Interfaces & flows

**New table — `eval_run_batches` (§1.2)**

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `workspace_id` | `uuid not null` | FK `workspaces(id) on delete cascade` |
| `owner_kind` | `text not null` | `'agent' \| 'skill'`; this feature writes `'agent'` only |
| `owner_id` | `uuid not null` | `agents.id` |
| `agent_version` | `integer` | nullable snapshot of `agents.version` |
| `system_prompt` | `text not null` | verbatim snapshot; powers the prompt-diff view |
| `model`, `provider` | `text not null` | resolved at batch creation |
| `ran_at` | `timestamptz not null` | `default now()` |
| `finished_at` | `timestamptz` | null while running |
| `status` | `text not null` | `'running' \| 'succeeded' \| 'failed'`, default `'running'` |
| `cases_total` | `integer not null` | also serves as `traces_total` (AC-47) |
| `traces_passed` | `integer not null` | default `0` |
| `recall`, `precision`, `citation_accuracy` | `double precision` | nullable by design (AC-49..AC-51) |
| `duration_ms`, `tokens_in`, `tokens_out` | `integer` | nullable |
| `cost_usd` | `double precision` | nullable |
| `error` | `text` | nullable |

**Altered table — `eval_runs` (§1.3)**

| change | notes |
|---|---|
| `+ batch_id uuid references eval_run_batches(id) on delete cascade` | nullable only so the `ALTER` is safe on pre-existing rows; every row this feature writes sets it (AC-2) |
| `case_id` unchanged (`NOT NULL`) | a row stays "one case executed once" |

**Existing table — `eval_cases` (§1.1), column usage fixed**

| column | use |
|---|---|
| `owner_kind` | always `'agent'` |
| `owner_id` | `agents.id` |
| `name` | short label, unique per owner, ordering key (no `created_at` exists) |
| `input_diff` | unified-diff fragment, non-empty, must parse to >= 1 file |
| `input_files` | unused — always `null` |
| `input_meta` | `EvalCaseMeta` |
| `expected_output` | `EvalExpectation` |
| `notes` | free text, nullable |

**Contract shapes (`contracts/eval-ci.ts`, mirrored server ↔ client — AC-79)**

| Name | Shape | Notes |
|---|---|---|
| `EvalExpectationKind` (new) | `'must_find' \| 'must_not_flag'` | the only two kinds |
| `EvalExpectation` (new) | `{ kind, file, start_line, end_line, severity?, category?, title? }` | `end_line >= start_line`; only the first four fields are read by the scorer (AC-48) |
| `EvalCaseMeta` (new) | `{ source_finding_id?, source_pr_id?, source_review_id?, origin: 'finding' \| 'manual' }` | `origin` distinguishes the two creation paths (AC-14, AC-16) |
| `EvalCaseManualInput` (new) | `{ name, input_diff, expected_output, notes? }` | body of both `POST` and `PUT` on `/eval-cases` |
| `EvalBatchRecord` (new) | the batch row minus `system_prompt` | list-safe (AC-59) |
| `EvalBatchDetail` (new) | `{ batch, system_prompt, cases: EvalRunRecord[] }` | reuses the shipped per-case `EvalRunRecord` as-is |
| `EvalRunComparison` (new) | `{ a, b, system_prompt_a, system_prompt_b, delta }` | `a` is always the older run (AC-56); `delta.X = b.X - a.X` (AC-54) |
| `EvalDashboardAgentSummary` (new) | `{ agent_id, agent_name, model, cases_total, last_run, trend }` | `trend` reuses the shipped `EvalTrendPoint` |
| `EvalDashboardIndex` (new) | `{ agents, recent_runs }` | `recent_runs` elements extend `EvalBatchRecord` with `agent_name` |
| `EvalDashboard` (changed) | `recent_runs` element type becomes `EvalBatchRecord` | §2.8; the contract has zero consumers today, so this is not a breaking change in practice. `current`, `delta`, `trend`, `alert` are kept verbatim — but see Open questions Q1 |
| `EvalRunResult`, `EvalCaseInput` | unchanged, dormant | this feature runs everything as a batch and creates cases via `EvalCaseManualInput`; do not delete them |

**Endpoints in scope (§4)**

| Endpoint | Purpose | Key behaviour |
|---|---|---|
| `POST /agents/:id/eval-runs` | run the set (or a subset) as one batch | AC-23..AC-31, 201 `EvalBatchDetail` |
| `GET /agents/:id/eval-runs` | run history | AC-53, 200 `EvalBatchRecord[]` |
| `GET /agents/:id/eval-runs/compare` | side-by-side of two runs | AC-54..AC-58, 200 `EvalRunComparison` |
| `GET /agents/:id/eval-runs/:batchId` | one run with its prompt and per-case rows | AC-26, 200 `EvalBatchDetail` |
| `GET /agents/:id/eval-cases` | the set | AC-20, 200 `EvalCase[]` |
| `POST /agents/:id/eval-cases/from-finding` | one-click case creation | AC-5..AC-15, 201 (or 200 when idempotent) |
| `POST /agents/:id/eval-cases` | Case Editor create | AC-16..AC-18, 201 |
| `PUT /agents/:id/eval-cases/:caseId` | Case Editor update | AC-21, 200 |
| `DELETE /agents/:id/eval-cases/:caseId` | remove a case | AC-22, 204 |
| `GET /eval-dashboard` | landing view across agents | AC-61, 200 `EvalDashboardIndex` |
| `GET /eval-dashboard/:agentId` | one agent's current / delta / trend / alert | AC-64..AC-67, 200 `EvalDashboard` |

The literal `compare` segment must be registered before the `/:batchId` uuid route
(precedent `server/src/modules/agents/routes.ts:100-102`), or `compare` is swallowed as a
malformed uuid.

**Set-run flow**

1. Resolve `workspaceId` from the request context, then the agent. Unknown agent → 404
   (AC-26).
2. Load the agent's cases (all, or the requested `case_ids`). Zero cases → 422 (AC-25).
3. Create the batch row: snapshot `system_prompt`, `agent_version`, `model`, `provider`;
   `status = 'running'`, `cases_total = <case count>` (AC-1, AC-29).
4. For each case, in order, sequentially (AC-27): parse `input_diff` (AC-31), call
   `reviewPullRequest` with the frozen input set (AC-28), and write one `eval_runs` row
   carrying `batch_id`, `pass`, and `actual_output`
   `{ findings, dropped, grounding, matched_finding_id, error? }` (§4.7). A parse failure
   or a provider error records the case as failed and continues (AC-32, AC-33).
5. Score the collected per-case results with the pure `reviewer-core` scorer (AC-37) into
   `recall`, `precision`, `citation_accuracy`, `traces_passed`.
6. Finalise the batch: metrics, `traces_passed`, `duration_ms`, cost/token totals,
   `finished_at`, and `status` — `'failed'` only if every case errored (AC-35, AC-36).
7. Return `EvalBatchDetail`. There is no progress route and no SSE stream in this feature;
   the POST is synchronous and the client shows a running state for its duration.

**Frozen review input per case (§4.5)** — `systemPrompt`, `model`, the parsed
`UnifiedDiff`, the injected `llm`, `strategy`, the enabled `skills` bodies, a `task` label
and a `sessionId` of the form `eval:<agentId>:<batchId>`. Deliberately absent: `callers`,
`repoMap`, `specs`, `prDescription` — a synthetic diff has no repository behind it, and
withholding them is what makes two runs of different agent versions comparable (AC-28).

**Module boundaries.** The scorer lives in `reviewer-core/src/eval/score.ts` (pure, no
I/O), exposing `matches`, `scoreCase` and `scoreBatch` re-exported from
`reviewer-core/src/index.ts` (§3.5, AC-87); the new `server/src/modules/eval/` owns
routes, service and repository; the per-file patch-assembly helper is hoisted into
`server/src/modules/_shared/diff-fragment.ts` as `assembleDiffFragment(files)` — string
assembly only, with the caller fetching the rows and invoking `parseUnifiedDiff` itself
(§3.5) — so both `modules/reviews` and `modules/eval` call one implementation;
`modules/eval` importing `modules/reviews` is forbidden by the onion rule. Reading `findings`/`reviews`/`pr_files`
through `modules/eval`'s own repository is established practice
(`server/src/modules/reviews/repository/run.repo.ts:23` joins `t.agents`).

**Client surfaces (§5.3)**

| Surface | Path |
|---|---|
| Evals tab | `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/` |
| Case Editor modal | `.../EvalsTab/_components/EvalCaseModal/` |
| Dashboard page (thin) | `client/src/app/eval-dashboard/page.tsx` |
| Dashboard view | `client/src/app/eval-dashboard/_components/EvalDashboardView/` |
| Shared metric tiles / runs table | `client/src/components/eval/` |
| Comparison modal | `client/src/components/eval/EvalRunComparison/` |
| Hooks | `client/src/lib/hooks/eval.ts`, re-exported from `lib/hooks/index.ts` |

Query keys: `["eval-cases", agentId]`, `["eval-runs", agentId]`, `["eval-batch", batchId]`,
`["eval-compare", agentId, a, b]`, `["eval-dashboard"]`, `["eval-dashboard", agentId]`.

## Inputs (provenance)

**Reused, unchanged**

- `[reused: shipped schema]` `eval_cases` and `eval_runs` — `server/src/db/schema/eval.ts:7-35`,
  created by `0000_init.sql:116-127`, previously unused by any route. No column is
  repurposed (AC-4).
- `[reused: shipped contracts]` `EvalRunRecord`, `EvalTrendPoint`, `EvalDashboard`,
  `EvalOwnerKind`, `EvalCase`, `Severity`, `FindingCategory`, `Finding` — all already in
  `contracts/eval-ci.ts` / `contracts/knowledge.ts` / `contracts/findings.ts`.
  `EvalRunResult` and `EvalCaseInput` stay dormant and untouched.
- `[reused: engine entry point]` `reviewPullRequest` — `reviewer-core/src/review/run.ts:123`.
  Called with a pre-parsed diff and an injected provider; no PR, no repo, no clone.
- `[reused: grounding gate output]` `ReviewOutcome.dropped[]` —
  `reviewer-core/src/review/run.ts:101`. Read only, as the denominator input for
  `citation_accuracy` (AC-46). The gate itself is untouched.
- `[reused: existing parser]` `parseUnifiedDiff` — `server/src/adapters/git/diff-parser.ts:14`.
- `[reused: persisted data]` `pr_files.patch` — per-file patches already stored, which is
  what makes case creation fully offline (AC-9). Precedent: `diffFromPrFiles`,
  `server/src/modules/reviews/diff-loader.ts:31-42`.
- `[reused: shipped copy]` `client/messages/en/eval.json` — already carries the
  `dashboard.*`, `caseEditor.*` and `evalsTab.*` keys this feature renders. Read it before
  inventing keys (AC-80).
- `[reused: shipped nav item]` `client/src/vendor/ui/nav.ts:41` — the `Eval Dashboard`
  sidebar entry already exists, disabled and pointing at `#`; enabling it is a one-line
  edit (AC-77). `activeKeyFor` already matches `/eval*`.
- `[reused: prior art, generalized]` `AgentsService.evaluateSkillsAB` —
  `server/src/modules/agents/service.ts:258-296` — already runs `reviewPullRequest` against
  a stored fixture diff for an ephemeral A/B skills comparison. This feature generalizes
  that one-shot comparison into a persisted, scored, comparable set-run. The existing
  method is not modified.
- `[reused: existing primitives]` `MetricCard`, the grid-based table convention and the
  `Modal` primitive on the client; `platform/errors.ts` typed errors and the Zod
  route-schema convention on the server.

**New**

- `[new: table]` `eval_run_batches` + migration `0018_eval_run_batches.sql` + journal
  entry (AC-1, AC-3).
- `[new: column]` `eval_runs.batch_id` (AC-2).
- `[new: contracts]` `EvalExpectation`, `EvalCaseMeta`, `EvalCaseManualInput`,
  `EvalBatchRecord`, `EvalBatchDetail`, `EvalRunComparison`,
  `EvalDashboardAgentSummary`, `EvalDashboardIndex`; one element-type change to
  `EvalDashboard.recent_runs` (AC-62).
- `[new: server module]` `server/src/modules/eval/` (routes, service, repository) plus one
  registration entry in `server/src/modules/index.ts`.
- `[new: pure module]` `reviewer-core/src/eval/score.ts`, exported from
  `reviewer-core/src/index.ts` (AC-37).
- `[new: client]` `lib/hooks/eval.ts`, `components/eval/*`, the Evals tab, the Case Editor
  modal, and the `/eval-dashboard` route.
- `[new: gate]` `verify:l06` in `server/package.json` and the `PreToolUse` hook in
  `.claude/settings.json` (AC-81, AC-83).

**LLM-call budget**

- `[new call: N LLM calls per run]` — exactly one `reviewPullRequest` call per case, run
  sequentially. A batch over N cases costs N calls; the 8-case demo set costs 8 (AC-27).
- `[deterministic: zero LLM calls]` — **all** scoring. Matching, `recall`, `precision`,
  `citation_accuracy`, `pass`, `traces_passed`, the dashboard deltas and the alert
  threshold are pure computation (AC-37..AC-52, AC-65..AC-67). The scorer's module
  boundary — no `fs`, no `fetch`, no `process.env`, no `src/llm/**` import — is what makes
  this structurally true rather than merely asserted, and `verify:l06`'s hermeticity is
  the proof (AC-82).
- `[deterministic: zero LLM calls]` — case creation from a finding, including diff
  assembly, slug de-duplication and expectation derivation (AC-5..AC-15).

## Untrusted inputs

This feature deliberately **stores** third-party text and **replays it into a model
prompt later**, which is a longer-lived exposure than a live review: a case created today
is re-sent to the model on every future run. Each of the following is data to be
processed, never instructions to be followed.

- **`eval_cases.input_diff`** — a fragment of a pull request's own diff, assembled from
  `pr_files.patch` (AC-9) or pasted by hand into the Case Editor (AC-16). It is
  PR-author-controlled content and can contain anything a source file can contain,
  including text shaped like a system instruction. **Boundary:** the review prompt
  assembled by `reviewer-core/src/prompt.ts` for every case in every run (AC-85).
- **The finding's `title`** (and, transitively, the case `name` slugged from it — AC-13) —
  LLM-authored during a prior review, but itself derived from untrusted diff content. It
  reaches the model as part of the per-case `task` label (AC-85), and reaches the browser
  as a list label (AC-86).
- **The finding's `rationale`** — same provenance as the title. It is *not* passed into the
  eval run's prompt by the frozen input set (AC-28); it is stored for display only. Do not
  add it to the prompt without re-opening this section.
- **`eval_cases.notes`** and the Case-Editor-supplied `file` path — user-supplied free
  text, rendered in the browser (AC-86) and, for `file`, compared as an opaque string by
  the scorer with no filesystem access whatsoever (AC-37, AC-38).

Two boundaries carry the mitigation. Server-side, every one of these fields that enters a
prompt is wrapped as untrusted background content with an explicit no-instructions clause
(AC-85), the same discipline the existing review path applies to a live diff. Client-side,
all of them render as text with no `dangerouslySetInnerHTML` (AC-86) — a case name is a
plausible stored-XSS carrier precisely because it originates from a model's summary of an
attacker-influenced diff.

Note the property that makes the *scorer* safe by construction: it never sees a prompt, a
provider or a filesystem (AC-37), so no amount of adversarial content in a stored case can
influence a score beyond the file-path and line-range comparison the contract defines.

## Traceability

| AC-id | US-id | module | task-id |
|---|---|---|---|
| AC-1 | US-4, US-5, US-6 | server | — |
| AC-2 | US-4 | server | — |
| AC-3 | US-4 | server | — |
| AC-4 | US-1, US-2, US-8 | server | — |
| AC-5 | US-1 | server | — |
| AC-6 | US-2 | server | — |
| AC-7 | US-1, US-2 | server | — |
| AC-8 | US-1, US-2, US-3 | server | — |
| AC-9 | US-1, US-2, US-10 | server | — |
| AC-10 | US-1, US-2 | server | — |
| AC-11 | US-1, US-2 | server | — |
| AC-12 | US-1, US-2 | server | — |
| AC-13 | US-1, US-2, US-3 | server | — |
| AC-14 | US-1, US-2 | server | — |
| AC-15 | US-1, US-2 | server | — |
| AC-16 | US-8 | server | — |
| AC-17 | US-8 | server | — |
| AC-18 | US-8 | server | — |
| AC-19 | US-3, US-8 | server | — |
| AC-20 | US-3 | server | — |
| AC-21 | US-8 | server | — |
| AC-22 | US-8 | server | — |
| AC-23 | US-4 | server | — |
| AC-24 | US-4 | server | — |
| AC-25 | US-4 | server | — |
| AC-26 | US-4, US-6 | server | — |
| AC-27 | US-4, US-10 | server | — |
| AC-28 | US-4, US-10 | server | — |
| AC-29 | US-6 | server | — |
| AC-30 | US-6 | server | — |
| AC-31 | US-4 | server | — |
| AC-32 | US-12 | server | — |
| AC-33 | US-12 | server | — |
| AC-34 | US-12, US-5 | server, reviewer-core | — |
| AC-35 | US-12 | server | — |
| AC-36 | US-12 | server | — |
| AC-37 | US-10 | reviewer-core | — |
| AC-38 | US-5 | reviewer-core | — |
| AC-39 | US-1, US-5 | reviewer-core | — |
| AC-40 | US-1, US-5 | reviewer-core | — |
| AC-41 | US-5, US-6 | reviewer-core | — |
| AC-42 | US-5 | reviewer-core | — |
| AC-43 | US-2, US-5 | reviewer-core | — |
| AC-44 | US-2, US-5 | reviewer-core | — |
| AC-45 | US-2, US-5 | reviewer-core | — |
| AC-46 | US-5 | reviewer-core | — |
| AC-47 | US-5 | reviewer-core | — |
| AC-48 | US-5 | reviewer-core | — |
| AC-49 | US-5 | reviewer-core | — |
| AC-50 | US-5 | reviewer-core | — |
| AC-51 | US-5 | reviewer-core | — |
| AC-52 | US-5 | reviewer-core | — |
| AC-53 | US-6 | server | — |
| AC-54 | US-6 | server | — |
| AC-55 | US-5, US-6 | server | — |
| AC-56 | US-6 | server | — |
| AC-57 | US-6 | server | — |
| AC-58 | US-6 | server | — |
| AC-59 | US-6, US-7 | server, client | — |
| AC-60 | US-6 | server, reviewer-core | — |
| AC-61 | US-7 | server | — |
| AC-62 | US-7 | server, client | — |
| AC-63 | US-5, US-7 | server | — |
| AC-64 | US-5, US-7 | server | — |
| AC-65 | US-7 | server | — |
| AC-66 | US-7 | server | — |
| AC-67 | US-7 | server | — |
| AC-68 | US-1, US-2 | client | — |
| AC-69 | US-1, US-2 | client | — |
| AC-70 | US-1, US-2 | client | — |
| AC-71 | US-3 | client | — |
| AC-72 | US-3 | client | — |
| AC-73 | US-5 | client | — |
| AC-74 | US-6 | client | — |
| AC-75 | US-8 | client | — |
| AC-76 | US-7 | client | — |
| AC-77 | US-7 | client | — |
| AC-78 | US-3, US-4, US-5, US-6, US-7, US-8 | client | — |
| AC-79 | US-3, US-4, US-5, US-6, US-7, US-8 | server, client | — |
| AC-80 | US-1, US-3, US-7 | client | — |
| AC-81 | US-9, US-10 | server | — |
| AC-82 | US-9, US-10 | server, reviewer-core | — |
| AC-83 | US-9 | cross-cutting | — |
| AC-84 | US-9 | cross-cutting | — |
| AC-85 | US-11 | server, reviewer-core | — |
| AC-86 | US-11 | client | — |
| AC-87 | US-5, US-10 | reviewer-core | — |
| AC-88 | US-2, US-5 | server, reviewer-core | — |

Module-value note: AC-83 and AC-84 govern `.claude/settings.json` at the repository root,
which belongs to none of the three modules named in this spec's header. They are tagged
`cross-cutting` — a value from the skill's allowed set, but not one this spec's (verbatim,
externally fixed) header declares. See Open questions Q3.

## Open questions

- **Q1. `EvalDashboard.current` nullability — RESOLVED by the lead, contract v1.3.**
  The shipped `EvalDashboard.current` typed `recall`, `precision` and `citation_accuracy`
  as non-nullable `z.number()` while §3.4 makes all three `null` on a zero denominator —
  reachable in normal use, since an agent whose newest run produced no findings has
  `precision === null` (AC-50). Two resolutions were possible: widen the fields, or coerce
  a `null` to `0` on the dashboard only. **The lead ruled: widen.** `current`'s three
  metrics and all three fields of `delta` become `.nullable()`. Coercion was rejected
  because `0` makes an agent that produced nothing indistinguishable from an agent that
  scored zero — the silent-wrong-answer failure §3.4 exists to prevent — and because
  `EvalRunComparison.delta` (§2.6) was already nullable, so coercing here would leave the
  two delta shapes disagreeing. `EvalDashboard` has no consumers, so the widening is free.
  AC-64 and AC-65 are written against the resolved shape; nothing remains blocked.
- **Q2. Spec filename deviates from the repository convention — resolved, not blocking.**
  The convention is `specs/YYYY-MM-DD-<slug>-spec.md` (see the sibling
  `specs/2026-07-13-why-risk-brief-spec.md`), but the course assignment's submission
  checklist names `specs/eval-pipeline.md` literally, and the graded filename wins; no
  content or traceability consequence follows from the path.
- **Q3. Header module list vs the hook's home — resolved, not blocking.** The spec header
  is fixed verbatim as `Modules: server, client, reviewer-core`, while AC-83/AC-84 govern
  `.claude/settings.json` at the repository root; those two rows are tagged `cross-cutting`
  in the Traceability table. This is a deliberate, recorded inconsistency with the skill's
  "header matches the table" consistency rule rather than a silent one — the alternative,
  mislabelling repo-root tooling as `server`, would be less accurate.
- **Q4. Strict precision's known cost — decided, recorded for posterity, not open.** A
  genuinely new second bug found inside a `must_find` case's diff scores as noise
  (AC-41). This was chosen deliberately over a lenient variant because a lenient precision
  cannot detect prompt noise, which is the measurement this feature exists to make. The
  mitigation is a dataset one (label the second bug as its own case), and it is documented
  in Edge cases and Non-functional. Do not soften it without re-opening contract §3.3.
- **Q5. Contract v1.2 deltas folded in — resolved, not blocking.** The contract advanced
  from v1 to v1.2 during this spec's drafting: §5.5's missing-i18n-key list was corrected
  and expanded (folded into AC-80), and a new §3.5 fixed the landed scorer API names and
  clarified that `matchedFindingId` means "first finding satisfying `matches`" for **both**
  expectation kinds — the offending finding on a failing `must_not_flag` case, not only the
  credited true positive on a `must_find` case (folded into AC-87 and AC-88). No earlier AC
  needed revision. Q1 above is unaffected by v1.2 and remains open.
- **Q6. Set-run POST is synchronous — decided by omission, recorded.** Contract §4 defines
  no progress or SSE route and §4.1 returns a fully-populated `EvalBatchDetail` on 201, so
  the run completes within the request. The `status = 'running'` default on the batch row
  (§1.2) exists for crash visibility, not for polling. If an 8-case run's latency proves
  unacceptable in practice, moving it behind the existing job/SSE machinery is a
  post-v1 change requiring a contract bump — not something an implementer may introduce.

## Self-check

- **Placeholder scan** — pass. No `TBD`, `TODO` or `<fill in>` anywhere. The one
  `[NEEDS CLARIFICATION]` marker raised at authoring time (AC-64 / Q1, a genuine
  contract-level contradiction) was escalated to the lead and resolved in contract v1.3;
  AC-64, AC-65 and Q1 now state the ruling. No marker remains.
- **EARS-testability** — pass. AC-1..AC-88 each match exactly one of the five patterns:
  ubiquitous (AC-1, AC-2, AC-3, AC-4, AC-8, AC-9, AC-11, AC-13, AC-14, AC-19, AC-27,
  AC-28, AC-29, AC-31, AC-34, AC-37, AC-38, AC-41, AC-42, AC-45, AC-46, AC-47, AC-48,
  AC-52, AC-58, AC-59, AC-62, AC-70, AC-73, AC-77, AC-78, AC-79, AC-80, AC-81, AC-82,
  AC-85, AC-87, AC-88), event-driven (AC-5, AC-6, AC-16, AC-20, AC-21, AC-22, AC-23, AC-39, AC-43,
  AC-53, AC-54, AC-60, AC-61, AC-64, AC-65, AC-68, AC-71, AC-72, AC-74, AC-76, AC-83,
  AC-86), state-driven (AC-36, AC-67), unwanted-behaviour (AC-7, AC-10, AC-12, AC-15,
  AC-17, AC-18, AC-25, AC-26, AC-32, AC-33, AC-35, AC-40, AC-44, AC-49, AC-50, AC-51,
  AC-55, AC-56, AC-57, AC-63, AC-66, AC-69, AC-84) and optional-feature (AC-24, AC-30,
  AC-75). Compound criteria were split during drafting: the four batch-metric formulas are
  AC-41/AC-42/AC-46/AC-47 rather than one AC; the three vacuous-denominator rules are
  AC-49/AC-50/AC-51; `status = 'failed'` (AC-35) and `status = 'succeeded'` (AC-36) are two
  ACs; `alert` present (AC-66) and `alert` null (AC-67) are two ACs.
- **Traceability** — pass. Every AC carries `(traces: US-x)`; every US-1..US-12 is covered
  by at least one AC, checked in both directions (US-1 → AC-5; US-2 → AC-6; US-3 → AC-20;
  US-4 → AC-23; US-5 → AC-41; US-6 → AC-54; US-7 → AC-61; US-8 → AC-16; US-9 → AC-83;
  US-10 → AC-27; US-11 → AC-85; US-12 → AC-32). The table is complete, one row per AC, and
  `task-id` is an em dash on every row — tasks are cut by the planner, never by this spec.
- **Verification** — pass. Every AC carries a concrete `(verify: …)` hint naming either a
  specific test file and case (mostly not-yet-existing, which is intended) or a runnable
  command (`rg`, `diff`, `git diff --stat`, `pnpm verify:l06`). No hint says "manual
  testing" or "QA will check".
- **Consistency** — partial, deliberately and visibly. The header's `server`, `client`,
  `reviewer-core` cover every module referenced in Interfaces & flows and 86 of the 88
  Traceability rows. AC-83 and AC-84 are tagged `cross-cutting` because they govern
  `.claude/settings.json` at the repository root; the header text was fixed verbatim by the
  dispatch and could not be widened. Recorded as Q3 rather than papered over.
- **Scope** — pass. Goals and Non-goals are both populated. No AC exceeds Goals: nothing
  here creates an `evals/` package, a `owner_kind: 'skill'` route, a grounding-gate change,
  a single-case run route, an automatic re-run on prompt edit, or a CI-workflow edit — all
  explicitly excluded. The local Postgres port change is environment setup and appears in
  no AC.
- **Ambiguity** — pass. No vague verb ("work fine", "handle gracefully", "as needed")
  survives. "Visibly moves the metrics" from the course criteria was narrowed to AC-60's
  concrete trigger (two prompts, same set, different finding sets) and concrete response
  (different batch metrics plus a non-zero delta from the compare route).
- **Untrusted inputs** — pass. The section names four specific inputs (`input_diff`, the
  finding `title` and its derived case `name`, the finding `rationale` as a deliberately
  excluded-from-prompt field, and `notes`/`file`), the two boundaries where they are
  consumed (the review prompt assembled per case; the browser), and the ACs that enforce
  the treatment (AC-85, AC-86).
- **No implementation detail** — pass. Interfaces & flows contains column tables, contract
  shape tables, an endpoint table and a numbered flow — no function bodies, no code
  snippets, no pseudocode. The one code-shaped line (`sessionId` of the form
  `eval:<agentId>:<batchId>`) is a value format fixed by the frozen contract, not an
  implementation choice. File paths in `(verify: …)` hints are verification instructions,
  not implementation guidance.
- **Open questions are explicit** — pass. Six entries, all now resolved: Q1 (the
  `EvalDashboard` nullability contradiction, escalated and ruled on in contract v1.3) plus
  five notes recorded for traceability (Q2 filename deviation, Q3 module-tag deviation,
  Q4 the strict-precision trade-off, Q5 the contract v1.2 deltas, Q6 the synchronous
  POST). Nothing was silently decided.
