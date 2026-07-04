# Intent Layer — P1 (MVP) — Development Plan

**Spec:** [`docs/superpowers/specs/2026-07-04-intent-layer-design.md`](../specs/2026-07-04-intent-layer-design.md) — §5 "P1 — MVP".
**Supersedes:** [`docs/superpowers/plans/2026-06-24-pr-overview-slice-d-intent.md`](2026-06-24-pr-overview-slice-d-intent.md) (never implemented; do not execute that plan).
**Scope:** P1 only. P2 (Jira/Linear) and P3 (URL fetcher) are explicitly out of scope for this plan and will be planned separately once P1 ships. Where the schema/contract must accommodate P2/P3 shapes (the `references` JSONB column, the `kind`/`status` enums), this plan builds that full shape now per spec §6.3/§7 — but wires up only the GitHub-linked-issue collector.
**Branch target:** new feature branch off `l03` (current branch).

## Goal

Ship a read-through cached `IntentCard` on the PR Overview tab: given a PR, an LLM extracts `goal` / `inScope` / `outOfScope` / `riskAreas`, using PR title + body + clipped diff + (if linked) full bodies of GitHub issues referenced in the PR body. Results are cached keyed by `(head_sha, body_hash)`; drift shows `ready-stale` with an explicit Refresh action. No auto-recompute.

## In scope

- Migration extending `pr_intent` (append-only) with freshness/reference/cost columns.
- Shared contract `PrIntentDto` + `PrIntentResponse` (4-state discriminated union incl. `ready-stale`), plus `IntentReferenceDto`/`kind`/`status` enums sized for all 3 phases.
- `resolveLinkedIssues()` extension on `OctokitGitHubClient` (all matches, not just first).
- `collectReferences` orchestrator with GitHub-issue collector wired; Jira/Linear/URL collectors stubbed to return `[]` (so the P1 shape and the P2/P3 call sites already exist and require no signature change later).
- Extractor (`extractIntent`), repository, service (freshness key + job handler + SSE), routes (`GET`, `GET .../stream`, `POST .../refresh`).
- Prompt file at `server/src/prompts/intent-extractor.system.md`.
- `IntentCard` component (5 states) + `useOverviewIntent` hook, wired into `OverviewTab`.
- Default-model change for `review_intent` (`gpt-4.1` → `claude-haiku-4-5-20251001`) in both vendor copies of `platform.ts`.
- Per-workspace (30/hr) and per-PR (1/min) server-side rate limits on compute/refresh.
- Unit tests for every pure/isolable unit; one `*.it.test.ts` covering cold → warm → drift → refresh → 429.

## Out of scope

- Jira/Linear adapters, ticket detection, "External trackers" settings UI (P2).
- URL fetcher, SSRF defenses, "Intent URL sources" settings UI (P3).
- Reference chip UI polish beyond what's needed to render GitHub-issue chips (✓/⚠ icon differentiation for `no_auth`/`unreachable`/etc. is exercised in P1 only for GitHub statuses that are actually reachable: `ok`, `not_found`, `unreachable`, `timeout`).
- e2e flow (`e2e/specs/pr-overview-intent.flow.json`) — spec §14.3 marks it optional; not included here to keep task count in the 8–12 target. Flag as a follow-up.
- Settings UI changes for the Models picker — spec §12.1 confirms the existing picker surfaces `review_intent` automatically; no UI task needed.

## Prerequisites / assumptions

- Working tree is clean on `l03` before starting; implementer creates a new feature branch off it per spec's "Branch target".
- Docker is available for `*.it.test.ts` runs (`server/test/helpers/pg.ts` gates on `dockerAvailable()` and skips cleanly otherwise — unit tests must still be proven green without Docker).
- The `server/src/modules/overview/` module already exists (`routes.ts`, `service.ts`, `repository.ts`, `brief/`) from a prior (already-implemented) slice. This plan extends that module with an `intent/` sibling and adds routes to the *existing* `overviewRoutes` plugin — it does **not** re-register a new plugin.
- `client/src/lib/hooks/overview.ts` and `OverviewTab.tsx` already exist (Slice A `useOverviewBrief` + `PrBriefCard`). This plan appends `useOverviewIntent` to the existing hook file and mounts `IntentCard` alongside `PrBriefCard` in the existing tab — it does not create new files for either.
- `RunEventKind` already includes `'info' | 'error' | 'done'` (`server/src/vendor/shared/contracts/trace.ts:9`) — no enum extension needed for SSE event kinds.

## Cross-cutting insights

- [`INSIGHTS.md` root, 2026-06-24 entry "SSE 'done' must be emitted by the layer that commits the side effect, not the layer that produces the data"] — the job handler must call `repo.upsert(...)` and only then `bus.publish(runId, 'done', ...)`, in that order, inside the same async function, before `bus.complete(runId)`. Do not let the extractor itself emit `'done'`.
- [`server/INSIGHTS.md`, 2026-06-23 entry "`vendor/shared/contracts/` is duplicated server↔client; manual sync only"] — every edit to `server/src/vendor/shared/contracts/brief.ts` and `platform.ts` must be mirrored byte-identical into `client/src/vendor/shared/contracts/brief.ts` and `platform.ts` respectively, in the same task, verified with `diff`.
- [`server/INSIGHTS.md`, 2026-06-23 entry "RunBus done-signal method is `complete(runId)`, not `done()`"] — use `container.runBus.complete(runId)` to end the SSE stream; there is no `done()` method.
- [`server/INSIGHTS.md`, 2026-06-23 entry "Drizzle migration commits must include `meta/_journal.json`"] and 2026-06-24 entries on snapshot-chain collisions / `when` ordering — generate the migration via `pnpm db:generate` where possible; if hand-writing, the journal `when` must be a fresh `Date.now()`-scale timestamp strictly greater than the last-applied entry, and the commit must include the journal + snapshot files, not just the `.sql`.
- **New finding from this planning pass (not yet in INSIGHTS, worth appending post-implementation):** `server/src/app.ts:103-105` disables `@fastify/rate-limit` entirely under `config.nodeEnv === 'test'` ("per-route overrides live on the routes themselves" — but they never fire in tests). The spec's rate-limit requirement (30/hr/workspace, 1/min/PR) and its `*.it.test.ts` assertion (§14.2 item 5, "2nd refresh within 60s returns 429") **cannot** be satisfied by `@fastify/rate-limit`'s per-route `config.rateLimit` alone, because (a) it's IP-keyed by default, not workspace/PR-keyed, and (b) it's a no-op in the test environment where the integration suite runs. Task T8 below implements the limits as an explicit in-memory limiter inside `IntentService`/routes (not via the `@fastify/rate-limit` plugin), so it is exercised identically in prod and test. This is flagged again under Risks.

## Task graph

#### Task P1-T1 — Migration: extend `pr_intent` with freshness + references + cost columns
- target_module: server
- files_to_touch:
  - `server/src/db/migrations/0015_pr_intent_overview.sql` (create)
  - `server/src/db/migrations/meta/_journal.json` (modify — new entry)
  - `server/src/db/migrations/meta/0015_snapshot.json` (create, via `drizzle-kit generate`)
  - `server/src/db/schema/reviews.ts` (modify — extend `prIntent` table)
  - `server/src/modules/reviews/repository/pull.repo.ts` (modify — remove dead `upsertIntent`/`getIntent` and their unused `Intent` import; see amendment note)
  - `server/src/modules/reviews/repository.ts` (modify — remove the wrapper methods `upsertIntent`/`getIntent` from `ReviewRepository` and their unused `Intent` import)
- depends_on: []
- **Amendment 2026-07-04 (scope expansion after initial dispatch):** the reviews module has a pre-existing pair of dead functions `upsertIntent`/`getIntent` (`pull.repo.ts:49-68` + `repository.ts:130-136` wrappers) that write to `pr_intent` with the old 4-column shape. Grep confirms zero call sites. Making `head_sha`/`body_hash` `NOT NULL` (per spec §6.1) breaks the typecheck of these dead functions. They violate the spec's single-writer rule anyway. Delete them (both fns + both wrappers + the unused `Intent` import in both files) as part of T1 — ~30 lines total, zero behavior change.
- description: Add `head_sha`, `body_hash`, `references` (jsonb, default `'[]'`), `risk_areas` (jsonb, default `'[]'`), `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `computed_at` to `pr_intent`, per spec §6.1. Give `head_sha`/`body_hash` a temporary `DEFAULT ''` then drop the default in a second statement (spec's exact SQL) so any pre-existing rows back-fill cleanly while future inserts must supply both explicitly. Update the Drizzle schema in `reviews.ts` to match exactly (import `numeric` alongside the existing `pg-core` imports), including the `IntentReferenceRow` and risk-area row shapes as inline `$type<...>()` generics (define these two row types locally in `reviews.ts` or import from a new `server/src/modules/overview/intent/types.ts` if you prefer — pick one, document in the file). Run `pnpm db:generate` from `server/` after editing the schema so the journal + snapshot are generated correctly (do not hand-write the journal entry — see INSIGHTS above on `when`-ordering and snapshot-chain collisions). If `db:generate` fails due to the known broken snapshot chain (root INSIGHTS/server INSIGHTS 2026-06-24 entries), fall back to hand-writing the `.sql` + a `_journal.json` entry whose `when` is `Date.now()` at generation time, and skip the per-migration snapshot (documented fallback in the same INSIGHTS entries).
- skills_to_apply:
  - `drizzle-orm-patterns`
  - `postgresql-table-design`
- insights_to_read:
  - `server/INSIGHTS.md` (entries: 2026-06-23 "Drizzle migration commits must include meta/_journal.json", 2026-06-24 "Drizzle snapshot chain in main is broken at 0012/0013", 2026-06-24 "Drizzle silently skips migrations whose journal `when` is earlier than the last-applied one")
- test_command: `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts' src/db && pnpm typecheck`
- definition_of_done:
  - `pr_intent` table in the Drizzle schema has all 9 new columns with exact names/types from spec §6.1.
  - `pnpm db:generate` (or the documented hand-written fallback) produces a migration file, and `meta/_journal.json` contains a new entry with `when` greater than the previous max.
  - Dead functions `upsertIntent` and `getIntent` are removed from `server/src/modules/reviews/repository/pull.repo.ts` and their wrapper methods removed from `ReviewRepository` in `server/src/modules/reviews/repository.ts`; the unused `Intent` import is dropped from both files.
  - `pnpm typecheck` is clean.
  - A subsequent `startPg()`-based integration test (any existing one, e.g. from the `overview` module) applies migration 0015 without error — verified by running the T8 integration test later in the plan, but the schema/migration alone must not break existing `*.it.test.ts` runs today (spot-check with one existing `*.it.test.ts` file if Docker is available).

#### Task P1-T2 — Shared contract: `PrIntentDto`, `PrIntentResponse`, reference/risk enums
- target_module: cross-cutting
- files_to_touch:
  - `server/src/vendor/shared/contracts/brief.ts` (modify — append new schemas; do NOT touch the existing `Intent` schema)
  - `client/src/vendor/shared/contracts/brief.ts` (modify — byte-identical mirror)
  - `server/src/vendor/shared/contracts/brief.test.ts` (create or append)
- depends_on: []
- description: Add `RiskAreaIcon`, `IntentReferenceKind` (4 values: `github_issue`/`jira`/`linear`/`url`), `IntentReferenceStatus` (8 values per spec §7), `IntentReferenceDto`, `PrIntentDto`, `PrIntentStaleReason`, and `PrIntentResponse` (discriminated union with `ready`/`ready-stale`/`computing`/`error`) exactly as specified in spec §7. Even though only `github_issue` is populated in P1, all 4 kind values and all 8 status values must be in the Zod enum now (per the task brief's explicit instruction) so P2/P3 need no contract migration. Append to the bottom of `brief.ts`, not interleaved with existing schemas.
- skills_to_apply:
  - `zod`
  - `breaking-change`
  - `response-schema`
  - `semver-discipline`
- insights_to_read:
  - `server/INSIGHTS.md` (entry: 2026-06-23 "`vendor/shared/contracts/` is duplicated server↔client; manual sync only")
  - `client/INSIGHTS.md` (entry: 2026-06-23 "`vendor/shared/contracts/` is a server↔client duplicate; sync manually")
- test_command: `cd server && pnpm exec vitest run src/vendor/shared/contracts/brief.test.ts && pnpm typecheck && cd ../client && pnpm typecheck`
- definition_of_done:
  - `PrIntentDto.safeParse(...)` accepts a full valid payload (goal/inScope/outOfScope/riskAreas/references/model/cost/computedAt) and rejects an unknown `RiskAreaIcon` value and an unknown `IntentReferenceStatus` value.
  - `PrIntentResponse.safeParse({status:'ready-stale', data, staleReasons:['head_sha']})` succeeds; `staleReasons: []` fails (`.min(1)`).
  - `diff server/src/vendor/shared/contracts/brief.ts client/src/vendor/shared/contracts/brief.ts` shows the new block is byte-identical (existing pre-diff content, if any, is unaffected).
  - Both `server` and `client` typecheck clean.

#### Task P1-T3 — Model default change: `review_intent` → claude-haiku-4-5-20251001
- target_module: cross-cutting
- files_to_touch:
  - `server/src/vendor/shared/contracts/platform.ts` (modify — line ~56, `defaultModel: 'gpt-4.1'` → `'anthropic/claude-haiku-4-5-20251001'`; also update `defaultProvider` if it currently reads `'openai'` and needs to become `'anthropic'` — verify against the `Provider` enum)
  - `client/src/vendor/shared/contracts/platform.ts` (modify — byte-identical mirror)
- depends_on: []
- description: Per spec §12.1/§16.1, change ONLY the `review_intent` entry's default in `FEATURE_MODELS` (server `platform.ts` line 52-57). Confirm `'anthropic'` is a valid `Provider` enum value (imported from `knowledge.ts`) before editing — if the enum doesn't include `anthropic`, that is a blocking discrepancy to surface, not silently work around. This change has zero DB migration impact: `resolveFeatureModel` only falls back to this default when no workspace override row exists (spec §16.1).
- skills_to_apply:
  - `typescript-expert`
  - `semver-discipline`
- insights_to_read:
  - `server/INSIGHTS.md` (entry: 2026-06-23 "`vendor/shared/contracts/` is duplicated server↔client; manual sync only")
- test_command: `cd server && pnpm typecheck && cd ../client && pnpm typecheck`
- definition_of_done:
  - `FEATURE_MODELS.find(f => f.id === 'review_intent')` returns `defaultModel: 'anthropic/claude-haiku-4-5-20251001'` and a `defaultProvider` value that is a member of the `Provider` zod enum, identically in both vendor copies.
  - No other `FEATURE_MODELS` entries are touched.
  - Both typechecks pass.

#### Task P1-T4 — Prompt file + `resolveLinkedIssues` (all-matches) on GitHub adapter
- target_module: server
- files_to_touch:
  - `server/src/prompts/intent-extractor.system.md` (create)
  - `server/src/adapters/github/octokit.ts` (modify — replace `resolveLinkedIssue` (singular, private) with a new exported `resolveLinkedIssues` returning all matches)
  - `server/src/vendor/shared/adapters.ts` (modify — add `resolveLinkedIssues` to the `ForgeClient` interface only if other call sites need it; otherwise keep it a concrete-class method used only by the intent collector — confirm which by checking existing `linked_issue` call sites before deciding)
  - `server/src/adapters/github/octokit.test.ts` (create, if no existing test file covers this adapter — check first)
- depends_on: []
- description: Per spec §10.1, extend regex matching to combine three patterns (closing-keyword `#NN`, bare `#NN` up to 5, and full GitHub URL refs which may point to a different repo), case-insensitive, deduplicated, returning `Array<{ number: number; url: string }>`. The existing private `resolveLinkedIssue` (singular) is called from `getPullRequest` to populate `PrDetail.linked_issue` (first match only) — do not break that call site; either keep the singular method as a thin wrapper (`resolveLinkedIssues(...)[0]`) or inline the equivalent logic, but `PrDetail.linked_issue` behavior must be unchanged. Write the prompt file verbatim per spec §8.5 (goal/inScope/outOfScope/riskAreas rules + the UNTRUSTED CONTENT CLAUSE, even though P1 only ever inlines `github_issue` references — the clause is written generically now since P2/P3 references share the same prompt).
- skills_to_apply:
  - `typescript-expert`
  - `security`
- insights_to_read:
  - (none module-local found for `adapters/github/` — proceed directly)
- test_command: `cd server && pnpm exec vitest run src/adapters/github/ --exclude '**/*.it.test.ts' && pnpm typecheck`
- definition_of_done:
  - `resolveLinkedIssues('Closes #12 and see #34, also https://github.com/other/repo/issues/9', repo)` returns 3 deduped entries with correct `number`/`url`.
  - Bare `#NN` matches are capped at 5 per call; closing-keyword matches are not capped.
  - Existing `PrDetail.linked_issue` behavior (single first-match) is unchanged — verified by an existing or new unit test.
  - `server/src/prompts/intent-extractor.system.md` exists and contains the UNTRUSTED CONTENT CLAUSE string verbatim from spec §8.5.
  - `pnpm typecheck` clean.

#### Task P1-T5 — `collectReferences` orchestrator + GitHub-issue collector (P2/P3 stubs)
- target_module: server
- files_to_touch:
  - `server/src/modules/overview/intent/references.ts` (create)
  - `server/src/modules/overview/intent/references.test.ts` (create)
  - `server/src/modules/overview/intent/types.ts` (create — see amendment below)
- depends_on: [P1-T4]
- **Amendment 2026-07-04 (design gap surfaced during T6 self-check):** spec §6.3's `IntentReferenceRow` is the *persisted* shape (bodyHash + bodyChars only, no raw text — by design, hash-stored). But `extractIntent` (T6) needs the raw body text to inline inside `<external_reference>` prompt blocks. Fix: introduce a transient in-memory type `CollectedReference = IntentReferenceRow & { body: string | null }` in a new `server/src/modules/overview/intent/types.ts`, plus a `toReferenceRow(r)` helper that strips `body` for persistence. `collectReferences` returns `CollectedReference[]`; `extractIntent` consumes `CollectedReference[]`; the service (T8, upcoming) calls `toReferenceRow` before passing to `repo.upsert`. No spec §6.3 change — the persisted shape is unchanged.
- description: Implement `collectReferences(container, workspaceId, body, repoOwner, repoName, log)` per spec §10.4 shape: calls `collectGithubIssues` (real, using `resolveLinkedIssues` + `container.forgeClient('github')` + `getIssue`, clipping each issue body to 8000 chars, computing a hash, and mapping fetch failures to `status: 'unreachable'`/`'not_found'` rows rather than throwing), plus `collectTrackerTickets` and `collectAllowlistedUrls` as literal stub functions that immediately return `[]` (documented with a `// P2` / `// P3` comment referencing the follow-up plan). Combine via `Promise.all`, dedupe by `(kind, id)`, cap at 5 total (spec §8.2). Each internal per-issue fetch uses `Promise.allSettled` so one failing issue fetch doesn't fail the whole collector (spec §8.2 "best-effort").
- skills_to_apply:
  - `typescript-expert`
  - `zod`
- insights_to_read:
  - `server/INSIGHTS.md` (entry: 2026-06-23 "Bitbucket `/diff` endpoint returns `text/plain`, not JSON" — general caution around adapter response-shape assumptions when calling `getIssue`)
- test_command: `cd server && pnpm exec vitest run src/modules/overview/intent/references.test.ts`
- definition_of_done:
  - Given a body with 2 valid linked issues and a mocked `forgeClient` where one `getIssue` call rejects, `collectReferences` returns 2 rows: one `status: 'ok'` with `bodyChars > 0`, one `status: 'unreachable'` — the collector itself never throws.
  - Result is capped at 5 entries even if the body links more than 5 issues.
  - `collectTrackerTickets` and `collectAllowlistedUrls` are separately unit-tested to confirm they return `[]` unconditionally (documents the P1 stub contract for future P2/P3 tasks).
  - Deduping by `(kind, id)` verified with a body containing the same issue number referenced twice (once bare `#12`, once as `closes #12`).

#### Task P1-T6 — Extractor: `extractIntent`, `bodyHashOf`, `clipDiff`
- target_module: server
- files_to_touch:
  - `server/src/modules/overview/intent/extract.ts` (create)
  - `server/src/modules/overview/intent/extract.test.ts` (create)
  - `server/src/modules/overview/intent/helpers.ts` (create — `bodyHashOf`, `clipDiff`)
  - `server/src/modules/overview/intent/helpers.test.ts` (create)
- depends_on: [P1-T2, P1-T5]
- description: Implement `clipDiff(files, totalCharBudget=80_000)` and `bodyHashOf(body)` exactly per spec §8.3/§6.2 (sha256 hex of `body ?? ''`). Implement `extractIntent(container, workspaceId, input: {title, body, diffSummary, references})` per spec §8.4: resolves the model via `resolveFeatureModel(container, workspaceId, 'review_intent')` (module import, matching the pattern in `feature-models.ts` — NOT `container.resolveFeatureModel`, confirm which the codebase actually uses by checking both call sites before writing), loads the system prompt via `loadPromptTemplate('intent-extractor.system.md')`, assembles the user message deterministically (Title/Body/Files/External references sections, only `status === 'ok'` references inlined, wrapped in `<external_reference kind="..." id="..." source="...">` per spec §8.4), calls `llm.completeStructured` with a payload-only Zod schema (goal/inScope/outOfScope/riskAreas — NOT the full `PrIntentDto`, since model/cost/computedAt/references are attached by the caller), and re-validates the assembled `PrIntentDto` before returning (defensive re-parse, per the superseded plan's proven pattern).
- skills_to_apply:
  - `zod`
  - `typescript-expert`
  - `security`
- insights_to_read:
  - `server/INSIGHTS.md` (entries: 2026-06-19 "Claude 4.x rejects `temperature`", 2026-06-19 "Anthropic structured-output reprompt needs `tool_result`, not text" — relevant now that the new default model is an Anthropic model, so `extractIntent`'s mocked-container unit test should not assume OpenAI-only wire behavior; the actual retry/temperature handling lives in the adapter, not here, but keep this in mind when picking test fixtures)
- test_command: `cd server && pnpm exec vitest run src/modules/overview/intent/extract.test.ts src/modules/overview/intent/helpers.test.ts`
- definition_of_done:
  - `clipDiff` gives each file a proportional share of the 80K budget clamped to `[400, 4000]` chars, and appends an overflow note when `files.length > 40`.
  - `bodyHashOf('')` === `bodyHashOf(null)` === `bodyHashOf(undefined)`; different bodies hash differently.
  - `extractIntent` with a mocked `container.llm(...).completeStructured` returning a valid payload produces a `PrIntentDto` whose `references` field equals the input references array unchanged, and whose `cost`/`model` come from the LLM wrapper response, not hardcoded.
  - `extractIntent` rejects (throws) when the mocked LLM returns an invalid `riskAreas[].icon`.
  - Only references with `status === 'ok'` appear inside `<external_reference>` blocks in the assembled user message — verified by inspecting the `messages` array passed to the mocked `completeStructured`.

#### Task P1-T7 — Repository: `pr_intent` row I/O
- target_module: server
- files_to_touch:
  - `server/src/modules/overview/intent/repository.ts` (create)
- depends_on: [P1-T1, P1-T6]
- description: Thin Drizzle wrapper, `IntentRepository.get(prId)` → `IntentRow | null` (maps DB row incl. `references`/`riskAreas` JSONB back to `PrIntentDto` shape) and `upsert(prId, key: {headSha, bodyHash}, result: ExtractIntentResult, references: IntentReferenceRow[])` using `onConflictDoUpdate` on `prId` (primary key), mirroring the superseded plan's Task 5 pattern but adding the `references` column write/read and dropping the old "row.model === null → treat as miss" guard (P1's migration back-fills `model` as nullable but new rows always populate it; a null-model row can only be pre-migration data, which spec §16.2 confirms doesn't exist in production today — still keep the guard for defensive safety, documented inline).
- skills_to_apply:
  - `drizzle-orm-patterns`
  - `onion-architecture`
- insights_to_read:
  - `server/INSIGHTS.md` (entry: 2026-06-23 "`linkSkill` upsert silently dropped explicit `enabled` on re-link" — same class of bug risk: the `onConflictDoUpdate.set` clause must explicitly list every column including `references` and `riskAreas`, or a refresh will silently fail to overwrite stale reference data)
- test_command: `cd server && pnpm typecheck` (no standalone unit test — repository is exercised by the T9 integration test per the existing Slice pattern; typecheck is the self-check gate here)
- definition_of_done:
  - `IntentRepository.upsert` writes all 9 extended columns; `onConflictDoUpdate.set` explicitly lists every column (including `references`, `riskAreas`) — no field can be silently preserved from a stale row on refresh.
  - `IntentRepository.get` round-trips a row into a `PrIntentDto` whose shape passes `PrIntentDto.parse(...)` without stripping fields.
  - `pnpm typecheck` clean; no `any` used for the JSONB row shapes (typed via the schema's `$type<...>()` generics from T1).

#### Task P1-T8 — Service: freshness key, job handler, `getOrCompute`/`refresh`, rate limits
- target_module: server
- files_to_touch:
  - `server/src/modules/overview/intent/service.ts` (create)
  - `server/src/modules/overview/intent/service.test.ts` (create)
- depends_on: [P1-T7]
- description: Implement `IntentService` per spec §9.2: `getOrCompute(workspaceId, prId)` returns `ready` / `ready-stale` (with `staleReasons` computed from head_sha/body diff, spec §6.2 drift matrix) / `computing` (enqueues `overview.intent` job with a fresh `runId`, only on cache miss). `refresh(workspaceId, prId)` always enqueues. The job handler (registered once via `container.jobs.register('overview.intent', ...)`) follows spec §8.1 exactly: publish `info` progress messages (Loading PR / Loading diff / Collecting references / Extracting intent), call `collectReferences` then `extractIntent`, call `repo.upsert(...)`, THEN publish `'done'`, THEN `bus.complete(runId)` in a `finally` — per the cross-cutting insight on SSE-done-ordering. **Rate limiting is implemented here, not via `@fastify/rate-limit`** (see Cross-cutting insights / Risks): add two small in-memory trackers on `IntentService` — a per-workspace sliding counter (30 computes/hour, keyed by `workspaceId`, incremented on every `getOrCompute` cache-miss enqueue AND every `refresh` call) and a per-PR last-refresh timestamp map (1/min, keyed by `prId`, checked only in `refresh`). Both throw a new `RateLimitedError` (add to `server/src/platform/errors.ts` — `code: 'rate_limited'`, `statusCode: 429`, optional `details: { retryAfterSeconds }`) when exceeded, so the route layer needs no special-casing beyond the existing error-to-HTTP mapping.
- skills_to_apply:
  - `fastify-best-practices`
  - `sse-patterns`
  - `onion-architecture`
  - `security`
- insights_to_read:
  - `INSIGHTS.md` root (entry: 2026-06-24 "SSE 'done' must be emitted by the layer that commits the side effect, not the layer that produces the data")
  - `server/INSIGHTS.md` (entry: 2026-06-23 "RunBus done-signal method is `complete(runId)`, not `done()` or `markDone()`")
- test_command: `cd server && pnpm exec vitest run src/modules/overview/intent/service.test.ts`
- definition_of_done:
  - Cold path (no row): `getOrCompute` returns `{status:'computing', runId}` and enqueues exactly once; after `jobs.onIdle()`, `repo.upsert` was called with the correct `headSha`/`bodyHash`.
  - Warm path (row matches freshness key): returns `{status:'ready', data}` with zero enqueues.
  - Drift path (headSha OR body changed): returns `{status:'ready-stale', data, staleReasons}` with the correct reason(s) per the drift matrix (head_sha only / body only / both) — 3 separate assertions.
  - `refresh` always enqueues regardless of freshness match.
  - A 31st `getOrCompute`/`refresh` call within the same workspace inside a rolling hour throws `RateLimitedError`; a 2nd `refresh` for the same PR within 60s throws `RateLimitedError` (both unit-tested with a fake clock or injectable time source — do not rely on real `setTimeout` delays in the unit test).
  - Job handler publishes `'done'` strictly after `repo.upsert` resolves, and `bus.complete` runs in a `finally` even when `extractIntent` throws (error path publishes `'error'` then still completes the bus).

#### Task P1-T9 — Routes: GET / GET stream / POST refresh + integration test
- target_module: server
- files_to_touch:
  - `server/src/modules/overview/routes.ts` (modify — add 3 intent routes to the existing plugin, alongside the existing `/pulls/:id/overview/brief` route)
  - `server/src/modules/overview/routes.it.test.ts` (modify — append intent test cases to the existing integration test file, OR create `server/src/modules/overview/intent/routes.it.test.ts` if the existing file is Slice-A-specific and adding intent cases would bloat an unrelated file — decide based on reading the current file's scope first)
- depends_on: [P1-T8]
- description: Add `GET /pulls/:id/overview/intent` (calls `service.getOrCompute`), `GET /pulls/:id/overview/intent/stream?runId=` (SSE via `reply.sse(...)` + `container.runBus`, mirroring the exact bridge pattern already used in `reviews/routes.ts`'s `/runs/:id/events` — same queue/resolve/done loop, `config: { rateLimit: false }` since it's a long-lived connection not burst traffic), `POST /pulls/:id/overview/intent/refresh` (calls `service.refresh`, returns 202 + `{runId}`, catches `RateLimitedError` — no special catch needed if `RateLimitedError extends AppError` and the app's global error handler already maps `AppError.statusCode` to the HTTP response; verify this mapping exists before assuming it). Write the integration test per spec §14.2 items 1-5: cold GET → computing, drain queue, warm GET → ready; POST refresh forces recompute; mutate `head_sha` → `ready-stale` with `['head_sha']`; mutate `body` → `ready-stale` with `['body']`; 2nd refresh within 60s → 429. Use `startPg()` from `server/test/helpers/pg.ts`, seed workspace/repo/PR/pr_files per the existing Slice pattern (see `server/src/modules/overview/routes.it.test.ts` if the file already seeds a PR — reuse the seed helper rather than duplicating).
- skills_to_apply:
  - `fastify-best-practices`
  - `sse-patterns`
  - `zod`
  - `breaking-change`
  - `response-schema`
- insights_to_read:
  - `server/INSIGHTS.md` (entry: 2026-06-23 "pr-self-review soft gate works end-to-end" — reminder that raw `throw new Error` / raw `fetch` on server routes are MUST findings; this task must use `RateLimitedError`/`NotFoundError`, never bare `Error`)
- test_command: `cd server && pnpm exec vitest run .it.test src/modules/overview`
- definition_of_done:
  - All 5 integration scenarios from spec §14.2 pass against a real Postgres via `startPg()`.
  - The 429 test specifically proves the in-memory limiter from T8 fires inside an actual HTTP round-trip (not just the service unit test) — this is the scenario blocked by `@fastify/rate-limit` being test-disabled, so it must NOT rely on that plugin.
  - SSE route returns `info`/`done`/`error` events with the exact shape `{id, event, data}` matching the pattern in `reviews/routes.ts`.
  - `pnpm typecheck` clean; route handlers contain no bare `throw new Error(...)`.

#### Task P1-T10 — Client hook: `useOverviewIntent`
- target_module: client
- files_to_touch:
  - `client/src/lib/hooks/overview.ts` (modify — append `useOverviewIntent` alongside the existing `useOverviewBrief`)
  - `client/src/lib/hooks/overview.test.ts` (create)
- depends_on: [P1-T2, P1-T9]
- description: Implement the hook per spec §13.2/§13.3: wraps `GET /pulls/:id/overview/intent` via `useQuery` (matching `useOverviewBrief`'s `api.get` pattern), and while the query result is `status: 'computing'`, opens an `EventSource`-based subscription to `GET /pulls/:id/overview/intent/stream?runId=...` (check how `reviews`' existing SSE consumer hook, if any, is implemented client-side and mirror that pattern rather than inventing a new one — grep `client/src/lib/hooks/` for an existing SSE-consuming hook first), forwarding `info` payloads into `progress` and calling `queryClient.invalidateQueries` on `done`. Exposes `refresh()` which calls `POST .../refresh` and expects a 429 to surface as a distinguishable error the component can render as a toast (per spec §13.6).
- skills_to_apply:
  - `react-best-practices`
  - `next-best-practices`
  - `zod`
- insights_to_read:
  - `client/INSIGHTS.md` (entry: 2026-06-23 "`vendor/shared/contracts/` is a server↔client duplicate; sync manually" — hook must import `PrIntentResponse`/`PrIntentDto` types from the already-mirrored `client/src/vendor/shared/contracts/brief.ts`, not redeclare them)
- test_command: `cd client && pnpm exec vitest run src/lib/hooks/overview.test.ts`
- definition_of_done:
  - Hook returns `status: 'loading'` while the initial query is in flight, `'ready'`/`'ready-stale'`/`'computing'`/`'error'` matching the 4 `PrIntentResponse` variants plus `'idle'` before `prId` is known.
  - When status is `'computing'`, a mocked SSE source emitting an `info` event updates `progress`; a `done` event triggers `invalidateQueries` for the `["overview-intent", prId]` query key.
  - `refresh()` on a 429 response resolves with an error the caller can inspect (not an unhandled rejection) — the component task depends on this contract.
  - `pnpm typecheck` clean in `client/`.

#### Task P1-T11 — `IntentCard` component (5 states) + wire into `OverviewTab`
- target_module: client
- files_to_touch:
  - `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.tsx` (create)
  - `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.test.tsx` (create)
  - `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/styles.ts` (create)
  - `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/index.ts` (create)
  - `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx` (modify — mount `<IntentCard prId={prId} />` alongside the existing `<PrBriefCard prId={prId} />`)
- depends_on: [P1-T10]
- description: Build the card per spec §13.3/§13.4: `loading` (skeleton, no actions), `computing` (skeleton + progress line + spinner, Refresh disabled), `ready` (full layout: goal, in/out-of-scope columns, risk chips, reference chips row — hidden when `references.length === 0`, footer with computed-at/cost/model), `ready-stale` (full card + amber banner "Stale — {reason}. [Refresh]"), `error` (red inline text + Refresh button). Refresh button present in every state, disabled during `loading`/`computing`. On a 429 from `refresh()`, show a toast ("You just refreshed — try again in Xs") rather than an inline error — check `client/src/lib/` for the existing toast utility (`CLAUDE.md` mentions `src/lib/theme`, `toast` under `src/lib/`) and reuse it. Reference chips: since only `github_issue` kind is ever populated in P1, the ✓/⚠/✗ status-icon logic can be implemented generically per spec §13.5 (it already covers all 8 statuses) even though only `ok`/`not_found`/`unreachable`/`timeout` are reachable from the T5 collector in practice.
- skills_to_apply:
  - `react-best-practices`
  - `react-testing-library`
  - `ui-architecture`
  - `next-best-practices`
- insights_to_read:
  - `client/INSIGHTS.md` (entries: 2026-06-23 "Optimistic-update RTL tests need `staleTime: Infinity` on the test QueryClient", 2026-06-23 "Vendor `Dropdown` items are `role=\"button\"`, not `role=\"menuitem\"`" if any dropdown/menu is used for chip tooltips)
- test_command: `cd client && pnpm exec vitest run "src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.test.tsx"`
- definition_of_done:
  - One RTL test per state (5 total) plus a Refresh-click test — all pass, matching spec §14.1's file/test enumeration.
  - `ready-stale` state renders the amber banner text containing the human-readable reason(s) derived from `staleReasons` (e.g. "head_sha" → "the PR was updated").
  - Reference chip row is entirely absent from the DOM when `references` is empty; present with correct ✓/⚠/✗ icon when non-empty.
  - `OverviewTab.tsx` renders both `PrBriefCard` and `IntentCard` without prop-type regressions; `pnpm typecheck` and `pnpm build` (or at minimum typecheck) succeed in `client/`.

## Verification (end-to-end)

```bash
cd server && pnpm typecheck && pnpm exec vitest run --exclude '**/*.it.test.ts'
cd server && pnpm exec vitest run .it.test src/modules/overview   # requires Docker
cd client && pnpm typecheck && pnpm exec vitest run
cd client && pnpm build
```

Manual/spec-level success criteria to re-check against spec §18 before calling P1 done:
- Fresh PR view: `IntentCard` moves `computing → ready` within ~10s for a typical PR.
- A PR with a linked `#42` produces a `goal` that reflects the issue's stated problem, not a restatement of the title alone (subjective — spot-check with a real or realistic fixture, not automatable in unit tests).
- Editing a PR's body and reloading shows `ready-stale`; clicking Refresh returns the card to `ready`.
- `review_intent`'s registered default is the new Anthropic model, and Settings → Models UI shows/overrides it with no additional code change.
- `/pr-self-review` run on the full diff before declaring P1 ready — MUST findings block, SHOULD findings go in the PR description (per root `CLAUDE.md`).

## Risks / open questions

- **Rate-limit test environment conflict (flagged above, restated as a blocking design decision, not a minor risk):** `@fastify/rate-limit` is disabled whenever `NODE_ENV=test` (`server/src/app.ts:103-105`), and its default keying is per-IP, not per-workspace/per-PR. This plan resolves it by implementing rate limiting as in-memory state on `IntentService` itself (T8) rather than as Fastify route config, which sidesteps both problems but means the 30/hr and 1/min counters live in process memory and reset on server restart / are not shared across horizontally-scaled instances. That's acceptable for the current single-process local-first architecture but should be called out explicitly in the PR description as a known limitation, not silently shipped as if it were the "real" rate-limiting mechanism the spec's §11.3 implies.
- **`resolveFeatureModel` call convention ambiguity:** spec text uses `resolveFeatureModel(container, workspaceId, 'review_intent')` (module-level import) in some places and `container.resolveFeatureModel(workspaceId, 'conventions')` (container method) in the actual `conventions/extractor.ts` code I read. Both exist in the codebase today. T6 explicitly calls out verifying which convention to use for the new intent extractor — pick whichever the majority of sibling modules (`conventions`, any others) use, and do not introduce a third pattern.
- **`ForgeClient` interface change scope (T4):** whether `resolveLinkedIssues` needs to become part of the public `ForgeClient` interface (in `vendor/shared/adapters.ts`) or can remain a concrete-class-only method on `OctokitGitHubClient` depends on whether the intent collector accesses it via `container.forgeClient('github')` (typed as `ForgeClient`) or via a github-specific import. Spec's architecture diagram (§4) shows `container.forgeClient` as the access path, which means the interface likely DOES need the new method — T4's implementer must resolve this by reading `vendor/shared/adapters.ts`'s `ForgeClient` interface and `BitbucketClient` (which does NOT support GitHub issues) before deciding whether to add an optional interface method or a type-narrowing cast at the call site in T5.
- **Existing `overview/routes.it.test.ts` scope unknown at plan time:** T9 assumes this file exists and is Slice-A-scoped (brief only); the implementer must read it first and decide append-vs-new-file. If it already integration-tests brief with a specific seed helper, reuse that helper rather than duplicating seed logic.
- **e2e flow (spec §14.3) is explicitly deferred**, not forgotten — track as a P1-follow-up task once the MockLLMProvider test-config wiring for `e2e/` is confirmed to exist (not verified during this planning pass).
- **No skill named exactly for "rate limiting design"** — `security` is the closest catalogue skill and is applied to T8; there is no dedicated `rate-limiting` skill to invoke.
