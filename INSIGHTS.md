# Cross-cutting insights

For learnings scoped to a single package, write in that package's `INSIGHTS.md`.
This file is for things that touch more than one package, or describe project-level decisions.

## Entry format

Use this template:

    ## YYYY-MM-DD — short title
    Context: what we were doing
    What we tried: approaches considered or attempted
    What worked: the approach that landed
    Why it matters: what to remember next time

Append-only in spirit. Don't edit old entries; add a new one if the world changes.

---

## 2026-06-23 — Auto-trigger /engineering-insights via Stop hook

Context: wanted the skill at `.claude/skills/engineering-insights/` to fire automatically at session wrap-up instead of relying on memory.

What we tried:
- `SessionEnd` hook — Claude isn't running, can't actually invoke the skill.
- `Stop` hook with `prompt`/`agent` type — schema rejects: those hook types only work for `PreToolUse`/`PostToolUse`/`PermissionRequest`.
- Once-per-session blocking command hook — landed.

What worked: a `Stop` command hook (`.claude/hooks/engineering-insights-reminder.sh`) that emits `{"decision":"block","reason":"..."}` to feed a reminder back to Claude, gated by a `/tmp/claude-insights-fired-<session_id>` marker so it fires at most once per session.

Why it matters: future hook work — `Stop`/`SessionStart`/`UserPromptSubmit` can only use `command`/`http`/`mcp_tool` types; the LLM-judge variants (`prompt`, `agent`) are off-limits. And `decision: "block"` is the documented path to push context back into Claude from a Stop hook.

## 2026-06-23 — Use `git status --porcelain` for "is the working tree dirty?"

Context: writing the engineering-insights Stop hook's "substantive work" detector.

What we tried: `git diff --quiet || git diff --cached --quiet` as the trigger check.

What worked: `[ -n "$(git status --porcelain)" ]`.

Why it matters: `git diff` inspects only tracked-file changes — adding new files (the common case for hook authoring, skill files, docs) leaves the diff empty and the trigger silent. Any heuristic that means "did anything change?" must use `git status --porcelain` (or `git ls-files --others --exclude-standard` to scope to untracked).

## 2026-06-23 — Pair Claude Code skill copies with hooks in the committed `.claude/settings.json`

Context: copied the engineering-insights skill into the project and added a Stop hook to auto-trigger it.

What we tried: considered putting the hook in `.claude/settings.local.json` (gitignored, personal-only).

What worked: hook in `.claude/settings.json` (committed). Skill copy under `.claude/skills/engineering-insights/` is also committed.

Why it matters: hook and skill ship together — a teammate cloning the repo gets the skill but the automation that triggers it would otherwise live in personal config they don't have. Pair both in the committed file. Reserve `settings.local.json` for personal allow-lists / workflow tweaks.

## 2026-06-23 — pr-self-review soft gate works end-to-end

Context: building the pre-ready architectural check (skills `ui-architecture`, `onion-architecture` + dispatcher workflow `pr-self-review`).

What we tried: planted one MUST violation per surface in a sub-worktree (raw `fetch` + `useEffect` data fetch on the client; raw `octokit` import + `throw new Error` on the server), ran the workflow.

What worked: workflow detected both surfaces, dispatched parallel review agents loaded with the architecture skill + the matching framework skills, returned all four expected MUST findings on the right files/lines plus two bonus SHOULD findings from `react-best-practices` — evidence the multi-skill loading composes.

Why it matters: confirms the soft gate is wired correctly end-to-end. The remaining risk is drift — Claude skipping the gate. Revisit if drift is observed.

## 2026-06-23 — Workflow tool is controller-only; spike tasks must reflect that

Context: building a dispatcher workflow with a sub-task that probes runtime behavior (subagent skill access).

What we tried: planned the probe step as part of an implementer subagent's task — "invoke the Workflow tool with this inline script".

What worked: the controller (main session) ran the probe directly; the implementer recorded the result. The Workflow tool is a controller-level orchestration tool — subagents (whether spawned via Agent or as workflow children) cannot invoke it, and the nesting rule explicitly forbids `workflow()` from a child.

Why it matters: when planning subagent-driven work, any step that needs Workflow/orchestration must be flagged as controller-executed. Implementers can do everything else; not this. (`.git/sdd/task-1-report.md` captured the in-flight redirect.)

## 2026-06-23 — Workflow `meta` rejects all non-literal expressions, including `+` concatenation

Context: Task 4 transcribed an example workflow body that joined a long `description` via three `'...' + '...' +` lines inside `meta`.

What we tried: ran the workflow; the runtime rejected it with `meta must be a pure literal: non-literal node type in meta: BinaryExpression`.

What worked: collapsing the description into a single string literal (commit `b6f5672`). The Workflow docstring says "must be a pure literal — no variables, function calls, spreads, or template interpolation" — but a `+` between two string literals also fails (it's a BinaryExpression at parse time, not a literal).

Why it matters: any multi-line description in `meta` must be one literal string, even if it gets long. Watch for this when transcribing example workflow code from docs or other projects — adjacent string-literal concatenation is the most common offender.

## 2026-06-23 — Workflow subagents inherit the Skill tool registry

Context: designing `pr-self-review` — needed to know whether a workflow subagent could load `ui-architecture`, `react-best-practices`, etc., or whether rules had to be inlined in the prompt.

What we tried: a one-shot probe workflow that spawned a subagent and asked it to `Skill(skill='react-best-practices')` and return the first heading line.

What worked: subagent successfully loaded the skill (probe returned `# React Best Practices & Anti-Patterns`). Documented in `docs/superpowers/notes/2026-06-23-subagent-skill-access-probe.md`.

Why it matters: future dispatcher workflows can compose multiple skills in a subagent prompt ("invoke skills X, Y, Z first, then review") instead of inlining rule lists. Cheaper to maintain; auto-updates when the skills change.

## 2026-06-23 — `repoIntel.getConventionSamples()` excludes config files via junk-path filter

Context: designing the Conventions Extractor pipeline, planning to use `getConventionSamples()` for all file sampling including eslint/tsconfig/prettier.

What we tried: expected the method to return config files since they contain the most explicit conventions in a repo.

What worked: discovered it is a thin wrapper around `getTopFilesByRank()` which applies `isJunkPath()` — this function explicitly filters out paths matching `'eslint'`, `'prettier'`, and `'.config.'`. Config files must be read separately in the extraction pipeline, outside of `getConventionSamples`.

Why it matters: an implementer who calls `getConventionSamples()` expecting config files will silently miss the richest source of explicit conventions with no error or warning. `server/src/modules/repo-intel/service.ts:630`.

## 2026-06-23 — Manually created Drizzle migration files are silently skipped without a journal entry

Context: implementing the Conventions Extractor — Task 1 manually wrote `0011_add_convention_category_created_at.sql` and ran `pnpm db:migrate`. Task 2 integration tests failed with "column 'category' does not exist".

What we tried: assumed `pnpm db:migrate` scans the migrations directory for `.sql` files and applies unapplied ones.

What worked: running `drizzle-kit generate`, which registered the existing SQL file in `_journal.json` and created the `0011_snapshot.json`. After that, `pnpm db:migrate` applied the migration correctly.

Why it matters: Drizzle's `migrate()` checks `_journal.json` to know which files to apply — it does not scan the filesystem for `.sql` files directly. A manually created migration is silently ignored with no error or warning until the journal entry exists. Always use `drizzle-kit generate` to register new migrations. `server/src/db/migrations/meta/_journal.json`.

## 2026-06-23 — RunBus done-signal method is `complete(runId)`, not `done()` or `markDone()`

Context: implementing `ConventionsService.startExtraction()` — needed to signal that the background extraction job was finished so the SSE stream would close.

What we tried: plan docs guessed `container.runBus.done(scanId)` as the done-signal method.

What worked: `container.runBus.complete(runId)` — found at `server/src/platform/sse.ts:76`.

Why it matters: the method name is not guessable from the consumer side (modules that call it) — you have to read the platform file. Future SSE background jobs must use `complete()`, not `done()`.

## 2026-06-23 — Extending `RunEventKind` breaks typecheck in `run-logger.ts` exhaustiveness map

Context: extending the `RunEventKind` enum in `trace.ts` to add conventions-specific event kinds (`'sampling'`, `'analyzing'`, `'verifying'`, `'done'`).

What we tried: adding the new values to the enum and running typecheck.

What worked: also updating the `LEVEL` map in `run-logger.ts` — an exhaustive `Record<RunEventKind, keyof PinoLike>` that TypeScript enforces at compile time.

Why it matters: the coupling between `trace.ts` and `run-logger.ts` is invisible unless you happen to run typecheck. Any future enum extension will break the same way. When adding to `RunEventKind`, always check `server/src/platform/run-logger.ts` for the `LEVEL` map and add entries for each new variant. `server/src/platform/run-logger.ts` + `server/src/vendor/shared/contracts/trace.ts`.

## 2026-06-24 — `/pr-self-review` only inspects uncommitted changes; silently skips when run after committing

Context: at the end of a subagent-driven implementation plan (`superpowers:subagent-driven-development`), every task lands as its own commit per SDD discipline. `CLAUDE.md` says "before marking work ready... run `/pr-self-review`" — but by then the working tree is clean and the workflow returns `{skipped: true, must: [], should: []}`.

What we tried: running `/pr-self-review` as the pre-ready gate after 4 task commits during the Agent Editor Versions tab work.

What worked: dispatching a fresh code-reviewer subagent over the committed range `BASE..HEAD` (here `f7cd0aa..f4ead73`) using `superpowers:requesting-code-review/code-reviewer.md` and the SDD `scripts/review-package` to pre-render the diff into a file. The reviewer caught a real `Badge` styling issue the focused per-task reviews had missed.

Why it matters: the project's pre-ready gate silently no-ops on committed work. A future contributor following `CLAUDE.md` literally will see "skipped" and think the gate passed when nothing was actually checked. Two workable patterns: (a) stage the final task's files but don't commit, run `/pr-self-review`, then commit — preserves the existing skill; (b) treat `/pr-self-review` as a mid-task gate against working-tree changes and use the SDD whole-branch reviewer at the end of multi-commit plans. Open follow-up: either extend the `pr-self-review` workflow to accept a `BASE..HEAD` range, or clarify in `CLAUDE.md` which gate applies at which point.

## 2026-08-25 — The Overview tab is a structural merge-conflict hotspot: every feature branch touches the same four files

Context: merging `origin/main` (L04 Blast Radius) into `l05` (Why+Risk Brief). Four conflicts, all in the Overview area, despite the two features sharing no logic.

What we tried: nothing preventive — the collision was discovered at merge time.

What worked: all four resolved as unions, none as either/or. The pattern is mechanical because every Overview feature adds a card the same way: a component import + JSX slot in `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`, a route line in the docblock of `server/src/modules/overview/routes.ts`, a `describe` block + import line in `client/src/lib/hooks/overview.test.ts`, and an append to `server/INSIGHTS.md`. Route handlers, hooks (`overview.ts`), and service code auto-merged cleanly every time — the conflicts are concentrated in the *aggregator* files, not the feature code.

Why it matters: two parallel L0x branches that both add an Overview card WILL conflict in exactly these four places, by construction, no matter how well-isolated their features are. Expect it and resolve as a union. Two specific traps: (1) `OverviewTab`'s prop signature widens per feature (L04 added `repoId`/`repoFullName`/`headSha`/`provider`), so taking "our" side of that function signature silently drops the other branch's props and breaks `page.tsx`'s call — always take the widened union; (2) `INSIGHTS.md` entries are chronological ascending and append-only, so the older branch's block goes FIRST, which is the opposite of what a "keep ours, then theirs" reflex produces. Cheap structural fix if this keeps hurting: give each card its own registry entry (an array of `{Component, props}`) so adding a card is an insertion in a list rather than an edit to shared JSX.

## 2026-08-25 — Rebuild a botched conflict resolution from git's merge stages (`:2:`/`:3:`), and prove no content was lost with `grep -vxF`
Context: resolving four conflicts in the l05←main merge with a Python script that spliced the "ours" and "theirs" halves of each conflict block together. `client/src/lib/hooks/overview.test.ts` came out of that splice missing its final `});\n});` — the offset arithmetic around the `=======` marker silently ate two closing braces.
What we tried: patching the seam by hand from the surrounding context. Guesswork — the truncation point was 160 lines from where the syntax error was reported (`TS1005: '}' expected` at the last line of the file), so the error location said nothing about the cause.
What worked: stop patching and rebuild from git's own conflict stages. `git show :2:<path>` is the exact "ours" blob, `git show :3:<path>` the exact "theirs" blob (`:1:` is the merge base) — available for any unmerged path while the merge is in progress. Reconstructed the file as `ours` with the import line replaced + `theirs`' unique tail appended. Then proved nothing was dropped with `grep -vxF -f <merged> <ours>` and the same against `theirs`: the only lines either side had that the merged file lacked were the two superseded import lines, exactly as intended.
Why it matters: scripted conflict resolution on marker offsets is fragile in a way that fails silently — it produces a plausible file that compiles-or-doesn't for reasons unrelated to where it broke. The stages give you ground truth to rebuild from, and the `grep -vxF` set-difference turns "I think I kept everything" into a checkable claim, which matters most on union resolutions where dropping one side's block is invisible in review. Both commands work only before the merge is committed; capture the stage blobs to files first if the merge might get committed or aborted mid-investigation.

## 2026-08-25 — L06's scaffolding was already in the repo: tables, contracts, i18n copy and a disabled nav item
Context: starting the Eval Pipeline feature (L06) from a task description that says "we give you the schema and the Zod contracts ready-made". The natural reading is that they arrive as an attachment.
What we tried: planning a migration that creates `eval_cases` and `eval_runs`, new API contracts, new UI copy, and a new sidebar entry — the full set, from scratch.
What worked: grepping the repo first. All of it already exists and is unreferenced: `eval_cases` + `eval_runs` in `server/src/db/schema/eval.ts:7-35`, created back in `server/src/db/migrations/0000_init.sql:116-127`; the entire L06 API surface (`EvalCaseInput`, `EvalRunRecord`, `EvalRunResult`, `EvalTrendPoint`, `EvalDashboard`) in `server/src/vendor/shared/contracts/eval-ci.ts`, whose own header comment says "A4 — Eval / CI / Compose / Conformance API contracts (L06)"; the dashboard, case-editor and evals-tab copy in `client/messages/en/eval.json`; the sidebar item in `client/src/vendor/ui/nav.ts:41` shipped as `{ key: "eval", href: "#", disabled: true }`; and `activeKeyFor` in `client/src/components/app-shell/helpers.ts:36` already routing `/eval*`.
Why it matters: this template pre-stages future lessons' scaffolding in files no current code path touches, so it is invisible to anyone who navigates by "what is running". A lesson's first move should be `rg -l '<feature-word>' server/src/db/schema server/src/vendor/shared/contracts client/messages client/src/vendor/ui` before writing a line of design — otherwise you produce a parallel, near-duplicate contract and a migration that collides with an existing relation. The same trap already bit SPEC-02, which discovered mid-spec that `pr_brief` was a pre-existing table it had to `ALTER` rather than `CREATE`.

## 2026-08-25 — `apiFetch` omits `content-type` on a body-less POST, so any `z.object()` body schema 422s
Context: the eval pipeline's "run every case" action posts to `/agents/:id/eval-runs` with nothing to say — the empty request *is* the instruction. The route declared `body: z.object({ case_ids: z.array(...).optional() })`: the field is optional, the envelope is not.
What we tried: sending no body from the client, which reads naturally and matches several existing body-less POSTs in this app (tour generate, refresh, reindex).
What worked: always sending an envelope (`JSON.stringify({})`) AND widening the route to `.nullish().transform(v => v ?? {})`, so neither side alone can bring the failure back. The chain is: `apiFetch` deliberately omits `content-type` when `init.body == null` (`client/src/lib/api.ts:38-44`, a guard against Fastify's "Body cannot be empty when content-type is application/json") → Fastify leaves `request.body` as `null` → the Zod object schema rejects `null` → this app's error handler renders it as **422 `validation_error`**, not the 400 you would grep for.
Why it matters: neither gate in this repo can see it. `pnpm typecheck` cannot — the mismatch is on the wire, not in the types, and both sides typecheck independently. The integration suite could not either, because its helper wrote `payload: caseIds ? { case_ids: caseIds } : {}` — `{}` satisfies the schema, and the client never sends `{}`. A test that materialises a default payload is testing a request shape that does not exist in production. Any route whose client caller can omit the body must either accept `.nullish()` or be covered by a test that sends *genuinely nothing*; asserting the fix works means reverting it and watching the test go red.

## 2026-08-25 — `git stash` in a worktree shared by parallel agents can sweep other agents' unfinished files
Context: this repo's SDD workflow dispatches several implementers concurrently against one working tree, on disjoint file scopes. One of them ran `git stash -u` to diff its own change against a clean baseline, then popped immediately.
What we tried: nothing preventive — disjoint *file scopes* were treated as sufficient isolation, and they are, for edits.
What worked: the pop restored everything (`git stash list` held only unrelated pre-existing entries afterwards), but the guarantee was luck, not design: `-u` sweeps untracked files across the whole tree, so every not-yet-committed file belonging to the other three tasks was inside the blast radius, and anything written *during* the stash window could have been lost silently. The durable fix was adding an explicit prohibition on `git stash`/`checkout`/`clean` to every subsequent context packet, and having the lead verify the other agents' trees rather than trusting the offending agent's "no data loss" self-check — its verification could only cover its own four files.
Why it matters: disjoint file scopes make parallel *edits* safe but do nothing about whole-tree commands. Any git command that mutates the working tree is effectively a global lock nobody is holding. Restrict parallel roles to read-only git (`status`/`diff`/`log`/`show`/`blame`), and if a baseline comparison is genuinely needed, use `git worktree add` on a temp dir or `git show <rev>:<path>` — both leave the shared tree untouched.

## 2026-08-25 — On macOS bash 3.2, `read` on a final line with no trailing newline skips the loop body — a silent no-op hook
Context: writing `.claude/hooks/pre-commit-test-gate.sh`, a `PreToolUse` gate that splits the incoming Bash command on `&&`/`;`/`|` and checks each segment against a `git commit` pattern.
What we tried: `while IFS= read -r segment; do ...; done < <(printf '%s' "$command" | sed ...)`. Tested against a chained command, which worked, and assumed it generalised.
What worked: `printf '%s\n'` — emitting a trailing newline before the split. macOS ships bash 3.2, where `read` returns non-zero when it hits EOF without a newline, so the loop body never executes for the LAST segment. A bare `git commit -m "..."` is a single segment, hence the last one, so the gate silently passed every real commit while looking correct on the multi-segment case. The alternative fix is `while IFS= read -r segment || [ -n "$segment" ]`.
Why it matters: the failure is completely silent — the hook exits 0 in ~16ms, no error, no output, and a hook that never fires is indistinguishable from a hook whose condition was not met. Two lessons for any future hook here: (1) never trust a shell loop over a producer that may not newline-terminate; (2) verify a hook by the case it exists to catch, in isolation, and time it — the gate takes ~9.5s when it actually runs the test lanes and ~20ms when it short-circuits, so wall-clock alone distinguishes "passed" from "never ran". A QA pass independently caught this by running the script with a crafted stdin payload rather than reading it.

## 2026-08-25 — Verify a blocking gate by making it block, not by watching it pass
Context: the same commit gate, plus the run-all request-body fix in the eval routes. Both are guards whose whole value is what they do in the failure case.
What we tried: confirming the green path — commit allowed, request accepted — and treating that as evidence the guard works.
What worked: forcing the red path. For the hook: a scratch failing test, then observing the actual `permissionDecision: "deny"` payload naming the lane and the assertion, then deleting the scratch file. For the request-body regression test: temporarily reverting the server schema and watching the new test fail with exactly the original 422, then restoring the fix.
Why it matters: a guard that never fires and a guard that fires correctly produce identical output on the happy path, so a green run proves nothing about either. This is the same reasoning the eval pipeline itself rests on — a `must_not_flag` case is worthless unless something can actually violate it. Cost is a minute; the alternative is shipping a gate that is decorative, which is worse than no gate because it is trusted.
