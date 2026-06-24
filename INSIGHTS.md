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
