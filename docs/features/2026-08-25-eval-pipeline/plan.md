# Plan — Eval Pipeline (L06)

Run dir: `docs/features/2026-08-25-eval-pipeline/`
Frozen contract: [`contract.md`](contract.md) v1 — every task builds against it, none edits it.
Spec: `specs/eval-pipeline.md`
Branch: `l06` (from `origin/main` @ `74f4f81`)

Every task's SCOPE shares zero files with any other task in the same wave.

---

## Wave 1 — foundations (3 parallel, fully disjoint)

### T1 — contracts + schema + migration
SCOPE
- `server/src/vendor/shared/contracts/eval-ci.ts`
- `client/src/vendor/shared/contracts/eval-ci.ts` (byte-identical mirror)
- `server/src/db/schema/eval.ts`
- `server/src/db/schema.ts`
- `server/src/db/migrations/0018_eval_run_batches.sql`
- `server/src/db/migrations/meta/_journal.json`

Contract sections: §1.1, §1.2, §1.3, §1.4, §2.1–§2.8.
DoD: `pnpm typecheck` green in both server and client; a fresh testcontainers DB applies
0018 (prove with an existing `*.it.test.ts` run, which calls `runMigrations`).

### T2 — the scorer (pure, zero LLM)
SCOPE
- `reviewer-core/src/eval/score.ts` (new)
- `reviewer-core/src/index.ts` (barrel export only)

Contract sections: §3 in full.
The scorer declares its own minimal structural input type
(`{ kind, file, start_line, end_line }`) rather than importing the Zod contract — that
keeps T2 independent of T1 and keeps `reviewer-core` free of a contract dependency it
does not need. `EvalExpectation` is structurally compatible by construction.
DoD: `npm run typecheck` green in reviewer-core; the module imports nothing from
`reviewer-core/src/llm/**`, no `fs`, no `fetch`, no `process.env`.

### T3 — hoist the patch-assembly helper
SCOPE
- `server/src/modules/_shared/diff-fragment.ts` (new)
- `server/src/modules/reviews/diff-loader.ts` (refactor to call it)

Contract section: §4.4 step 4.
Behaviour-preserving. `diffFromPrFiles` keeps its signature and its callers.
DoD: `pnpm test` in server stays green — no existing assertion changes.

## Wave 2 — server + client data layer (2 parallel)

### T5 — server `eval` module
SCOPE
- `server/src/modules/eval/routes.ts`, `service.ts`, `repository.ts` (all new)
- `server/src/modules/index.ts` (one registration entry)

Depends on T1, T2, T3. Contract sections: §4 in full, plus §1.1 for column usage.
Owns the only edit to `modules/index.ts` in this run — that aggregator is serialized to
this task by construction.
DoD: `pnpm typecheck` + `pnpm test` green; onion MUST.1–MUST.6 hold (no `modules/*`
cross-import, no raw I/O, typed errors, Zod schema on every route).

### T6 — client data layer + shared eval components
SCOPE
- `client/src/lib/hooks/eval.ts` (new), `client/src/lib/hooks/index.ts` (barrel line)
- `client/src/lib/api.ts` (eval methods)
- `client/src/components/eval/**` (new: `EvalMetricTiles`, `EvalRunsTable`,
  `EvalRunComparison`, `EvalTrendChart`)

Depends on T1 only — it builds against the frozen §4 routes, not against T5's code. That
is exactly what the freeze buys.
DoD: `pnpm typecheck` green in client.

---

## Wave 3 — UI surfaces (3 parallel, disjoint)

### T7 — Evals tab + Case Editor modal
SCOPE
- `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`
- `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx`
- `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/**` (new)
- `client/src/app/agents/[id]/page.tsx`
- `client/messages/en/agents.json`

Contract sections: §5.2, §5.3, §5.5. Copy already exists in `messages/en/eval.json` —
read it before inventing keys.

### T8 — Eval Dashboard page + sidebar
SCOPE
- `client/src/app/eval-dashboard/**` (new)
- `client/src/vendor/ui/nav.ts` (one line: enable the existing disabled item)

Contract sections: §5.3, §5.4. The `vendor/` edit is a declared do-not-touch zone and
must be surfaced in the final report, not buried.

### T9 — FindingCard action
SCOPE
- `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.tsx`
- `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/styles.ts`
- `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsPanel/FindingsPanel.tsx`
- `client/messages/en/prReview.json`

Contract section: §5.6.

---

## Wave 4 — tests (3 parallel, disjoint)

### T10 — the `verify:l06` gate (unit, hermetic)
SCOPE
- `server/src/modules/eval/scoring.test.ts` (new)
- `server/package.json` (add `verify:l06`)

Contract section: §6, asserting all of §3. No DB, no LLM, no network.

### T11 — contract-tier integration test
SCOPE
- `server/src/modules/eval/routes.it.test.ts` (new)

Covers every frozen boundary in §4 against a testcontainers DB with `MockLLMProvider`:
both expectation kinds end-to-end, the from-finding derivation including its 422s and its
idempotency, batch metric persistence, per-case failure isolation, and the compare route.

### T12 — client component tests
SCOPE
- `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/EvalsTab.test.tsx`
- `client/src/app/eval-dashboard/_components/EvalDashboardView/EvalDashboardView.test.tsx`
- `client/src/components/eval/**/*.test.tsx`
- `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingCard/FindingCard.test.tsx`

Mock `lib/hooks/*`, wrap in `NextIntlClientProvider` + `ToastProvider` — the
`AgentEditor.test.tsx` pattern.

---

## Wave 5 — gates and wrap (lead)

### T13 — PreToolUse test gate (stretch, independent)
SCOPE
- `.claude/hooks/pre-commit-test-gate.sh` (new)
- `.claude/settings.json` (add the `PreToolUse` block beside the existing `Stop` hook)

Read `.claude/hooks/engineering-insights-reminder.sh` as the shape exemplar.
Gate: a `Bash` tool call matching `git commit` runs the server + client unit lanes and
blocks on failure. Must be fast enough not to wreck the loop and must not fire on
non-commit Bash calls.
DoD: the hook fires on a `git commit` attempt with a deliberately failing test and blocks
it; it does not fire on `git status`. Evidence recorded in the run dir.

---

Deliberately scheduled LAST, after this run's own commits: a commit gate that blocks
`git commit` would otherwise sit in the middle of the lead's own commit sequence, and a
bug in it would stall the run it is being added by.

- Diff review (`dt-advisor`, REVIEW mode) over the whole branch diff.
- Acceptance verification (`dt-qa-tester`) against the spec's stable AC ids.
- Bounded fix loop, maximum 2 rounds.
- Documentation pass.
- Local commits, one per logical chunk.

---

## Acceptance criteria of the assignment, and who covers them

| criterion | covered by | verified by |
|---|---|---|
| set holds >= 8 cases | T5 (from-finding) + T7 (Case Editor) | manual — see Known dependency |
| one-click from a finding; both expectation kinds | T5 §4.4, T9 | T11 |
| a prompt change visibly moves recall/precision | T5 §4.5 frozen inputs, T2 scorer | manual experiment |
| scoring makes zero LLM calls | T2 (module boundary) | T10 (hermetic test) |
| `pnpm verify:l06` green | T10 | direct command |

---

## Known dependency the build cannot close

The dataset is the user's own accept/dismiss history. The local DB currently holds
**97 findings but only 1 accepted and 0 dismissed**, across 5 agents (14–28 findings
each). Every finding's file has a stored `pr_files.patch`, so offline case creation works
for all of them — but reaching >= 8 cases on one agent requires the user to accept or
dismiss roughly 8 findings for that agent first, or to add cases through the Case Editor
(T7). No task can manufacture those decisions without faking the dataset the assignment
is explicitly built on.

---

## Dispatch skip list

Roles deliberately not dispatched in this run, with the reason:

- `dt-architect` — no new architectural boundary to decide. Module placement follows an
  existing in-repo precedent (`modules/reviews/repository/run.repo.ts` joins another
  domain's table through its own repository), and the four genuine design forks were put
  to the user directly.
- `dt-designer` — the UI is fully designed; six screenshots were supplied and
  `client/messages/en/eval.json` already carries the copy.
- `dt-researcher` — nothing needed external investigation; every unknown was answerable
  from the codebase.
- `dt-browser-qa-tester` / `dt-api-qa-tester` — deferred to Wave 5, and conditional: the
  end-to-end browser flow needs LLM credentials and a seeded decision set, which is the
  Known dependency above. If it cannot run, its criteria are reported
  `UNVERIFIABLE HERE`, never PASS.
- `quality-gate.mjs` snapshot/evaluate — `.claude/dev-teams-tools/` does not exist in this
  repo. Baseline captured manually in `baseline.txt` instead.
