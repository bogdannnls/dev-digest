# Project Context Folder (L05) — implementation plan

Date: 2026-07-11
Status: **Approved for execution.**
Spec: [SPEC-01](../../../specs/2026-07-11-project-context-folder-spec.md) · Design: [design doc](2026-07-11-project-context-folder-design.md)
Branch: `feat/l05-project-context` (isolated worktree, to avoid a concurrent SDD-pipeline process in the main checkout).

## Coordinator decisions (rulings on planner flags)

1. **AC-17 (replay a past agent version) — vacuously satisfied; descope its test.** No execution path replays a pinned historical agent version; `agent_versions` is a read-only history view (`VersionsTab`). We still capture `attached_context_paths` in the config snapshot (AC-16), but there is nothing to "wire" a replay through. Do NOT invent a replay entrypoint. Version-pinned re-run is future work.
2. **Per-doc token size in the trace** → add an additive, nullish, index-aligned sibling field `specs_tokens: z.array(z.number().int()).nullish()` to `RunTrace` (both vendor copies), documented as same length/order as `specs_read`. Non-breaking; old traces (`[]`) stay valid. Do NOT widen `specs_read`'s element type.
3. **Governing-repo validation** → add a transient (never-persisted) `repo_id` field to `UpdateAgentBody` / `UpdateSkillBody`, required (`.refine`) whenever `attached_context_paths` is present; the service validates each submitted path against `container.context.listPaths(workspaceId, repo_id)` and 422s on unknown paths (AC-12/12b/12c).

## Goal

Turn a repo's own `specs/`/`docs/`/`insights/` markdown into review context: authors manually attach discovered docs to agents and/or skills (paths, not text); at run time the server reads them fresh, injects into the existing (unused) `## Project context` slot, and the trace records what was read + token size. Zero new LLM calls.

## Non-negotiable constraints

- Migrations append-only, NOT auto-applied: `pnpm --dir server db:generate --name attached_context_paths` then `pnpm --dir server db:migrate`; commit `.sql` + `meta/_journal.json` + `meta/0016_snapshot.json` together. Next is `0016`.
- `vendor/shared/contracts/*` is duplicated server↔client — edit BOTH copies in the same task or the other package's typecheck breaks.
- Integration tests use the `*.it.test.ts` suffix; they self-skip without Docker.
- `reviewer-core` is consumed by `server` via tsconfig path alias — no code change needed there (the `specs` slot already works); only tests are added.
- `client/src/vendor/` is do-not-touch except the single `nav.ts` enable line (T9) — flagged.
- **Path traversal is a hard MUST** — reject `../`, absolute, and symlink-escape; whitelist against the freshly-discovered set. Appears in the DoD of T1 (reader) and T4 (injection).
- Don't confuse the new `server/src/modules/context/` (markdown reader) with the pre-existing `server/src/db/schema/context.ts` (code-index tables).

## Task graph

| Task | Module | Depends on | Summary |
|---|---|---|---|
| T1 | server | — | Reader module: glob discovery + `GET /repos/:id/context`, `/context/file`, `POST …/reindex`; `listPaths()` shared primitive; `RepoNotClonedError` (409); path-safety in the `walk` (never follows symlinks). |
| T2 | server+contracts | T1 | Migration 0016 (both tables) + `attached_context_paths` on `agents`/`skills` schema; thread through Agent DTO/repo/service/routes + `AgentVersionConfig` snapshot + `isConfigChange` bump; transient `repo_id` + save-time validation. |
| T3 | server | T2 | Mirror T2 threading for skills (NO version bump on path change); make skill PUT body accept the field; `SkillsService` constructor → `private container`. |
| T4 | server+contracts+reviewer-core(test) | T1,T2,T3 | `buildSpecsDigest` in run-executor: effective-set merge (agent-first, enabled-skill order, dedupe first-wins) + fail-run pre-flight (reuse `listPaths`) + read + tokenize; wire `specs`/`specs_read`/`specs_tokens` into trace; reviewer-core prompt tests (AC-23/24/28). |
| T5 | server | T2,T3 | Regression-guard test: agent with `attached_context_paths` still evals cleanly with no repo clone; injection omitted (AC-45). No production wiring into `evaluateSkillsAB`. |
| T6 | client | T1 | Shared client primitives: `useContextFile` hook; `deriveContextKind()` (path→badge, `doc` fallback, no `SpecFile` field); read-only `ContextPreviewDrawer` (not-found state); audit/extend `context.json`. |
| T7 | client | T2,T3,T6 | Agent editor "Context" tab: dnd-kit list mirroring `SkillsTab`; own rows draggable/removable, inherited (enabled-skill) rows greyed/read-only; `AddContextDocPicker` sources active repo's `/context`; persists via `PUT /agents/:id`. |
| T8 | client | T3,T6 | Skill editor "Project context to use" section (edit-mode only, no inheritance). |
| T9 | client | T1,T6 | `/context` screen mirroring `SkillsListView` (distinct not-cloned vs empty states); enable the `nav.ts` item (the one vendor edit). |
| T10 | client | T4 | Run-trace "Specs read" panel: list paths + token badges; explicit empty state, panel always present. |
| T11 | controller | T2,T3,T4,T7 | **Manual live-check (AC-46)** — attach an invariant spec → violating PR → reviewer cites it. Runs on the orchestrator against a live stack, NOT a parallel implementer. |

Per-task `files_to_touch`, `skills_to_apply`, `insights_to_read`, `test_command`, and AC-tied `definition_of_done` are dispatched to each implementer verbatim from the approved planner output (held by the coordinator).

## Key insights the implementers must honor (from module INSIGHTS.md)

- Drizzle: migration commit MUST include `meta/_journal.json` + snapshot; never hand-edit `when`; generate, don't hand-author.
- `vendor/shared/contracts/` server↔client are manual-sync duplicates — dual-edit.
- A column + DTO + passing CRUD test does NOT mean production honors it — T4 is what makes `attached_context_paths` actually affect reviews (the `agent_skills.enabled` precedent).
- `@dnd-kit` `KeyboardSensor` doesn't fire in jsdom (mock `DndContext` for keyboard-drag tests); never `aria-hidden` a drag handle.
- `client/messages/en/context.json` already exists but its keys describe a stale editable/embedding vision — audit, don't blind-reuse.
- `MockGitClient.clonePathFor()` returns a synthetic non-existent path — T1's reader integration test needs a real `fs.mkdtemp` fixture (incl. a symlink) instead.

## Execution waves (dependency- and collision-aware)

Parallel implementers share the worktree working tree, so concurrent tasks must touch disjoint files and not typecheck a package another task is mid-editing (esp. dual-edited contracts).

- **Wave 1:** T1
- **Wave 2:** T2
- **Wave 3:** T3 ‖ T6 (server-skills vs client-primitives — disjoint; client contracts stable after T2)
- **Wave 4:** T4 (edits client `trace.ts`, so client UI tasks wait)
- **Wave 5:** T5 ‖ T7 ‖ T8 ‖ T9 ‖ T10 (all disjoint; contracts now stable)
- **Wave 6:** T11 (controller manual)

After each wave: stage the diff, run the relevant reviewers, commit per task/wave.

## End-to-end verification

1. `cd server && pnpm typecheck && pnpm exec vitest run --exclude '**/*.it.test.ts' && pnpm exec vitest run .it.test`
2. `cd reviewer-core && npm run typecheck && npm test`
3. `cd client && pnpm typecheck && pnpm test && pnpm build`
4. `cd server && pnpm db:migrate` on a fresh DB — 0016 applies cleanly.
5. T11 manual live-check.

## Risks

- AC-17 descoped (no replay path) — see Coordinator decision 1.
- Trace-shape and `repo_id`-field decisions are additive to the approved design — see decisions 2–3.
- Concurrent SDD process in the main checkout; mitigated by the isolated worktree. `feat/l05-project-context` also carries three unrelated SDD commits (`6c8c0ec`, `433c2e1`, `8622ad1`) that can be rebased out before a final PR.
