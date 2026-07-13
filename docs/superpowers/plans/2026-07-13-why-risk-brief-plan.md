# Development Plan: Why + Risk Brief

- **Source spec:** [`specs/2026-07-13-why-risk-brief-spec.md`](../../../specs/2026-07-13-why-risk-brief-spec.md) — SPEC-02 (45 EARS ACs, approved)
- **Design:** [`docs/superpowers/specs/2026-07-13-why-risk-brief-design.md`](../specs/2026-07-13-why-risk-brief-design.md)
- **execution_mode:** `multi` *(confirmed by user 2026-07-13)*
- **Author:** `implementation-planner` (read-only planning pass)
- **Date:** 2026-07-13

> Consumed by the `implementer` agent via `/sdd`. Every task's `definition_of_done`
> traces to specific AC ids in SPEC-02. All 45 ACs are covered (see the verification table);
> no gaps.

## Goal
Add a second, thin LLM pass that **composes** already-computed PR artifacts (Intent,
`RepoIntel.getBlastRadius`, latest-review findings, `SmartDiff`, attached-spec paths) into one
synthesized brief — a one-sentence what/why, a deterministically-floored risk level, and a
"Review focus — read these first" list grounded in real finding ids (never model-emitted
file:line). Read-through cached in the already-existing (currently zero-consumer) `pr_brief`
table via an additive migration, exposed as a new Overview-tab endpoint trio (`GET`,
`POST /refresh`, `GET /stream`) mirroring the Intent layer, rendered as a new
`WhyRiskBriefCard`. The dormant `PrBrief` composite is retired in the same effort, without
touching its still-used building-block schemas.

## In scope
- New shared contract `brief-synth.ts` (server + client mirror).
- Additive migration extending `pr_brief` (never `CREATE TABLE`).
- `server/src/modules/overview/brief-synth/` — input assembly, LLM call, repository, service, routes.
- Retirement of the dormant `PrBrief` composite from `contracts/brief.ts` (both copies).
- Client hook `useOverviewBriefSynth` + `WhyRiskBriefCard` + `OverviewTab.tsx` wiring.
- Integration test covering the full 5-state matrix + SSE + cost/rate-limit behavior.

## Out of scope
- Any new Blast Radius UI panel/route (blast is an LLM input only — Non-goal).
- Re-computation of intent, blast radius, findings, or smart-diff.
- Semantic spec retrieval (attached-context paths only).
- Wiring `platform/grounding.ts`'s citation gate onto this call (Non-functional forbids it — the model only selects ids from a provided set, so there is no free-text file:line to police).
- Auto-regeneration cascade of intent/review from `not_ready`.

## Dependency waves
- **Wave 1** (no deps, disjoint files): T1 (contract), T2 (migration), T8 (retirement)
- **Wave 2**: T3 (assemble-input ← T1), T4 (repository ← T1+T2), T10 (client hook ← T1)
- **Wave 3**: T5 (synthesize ← T1+T3)
- **Wave 4**: T6 (service ← T1+T2+T3+T4+T5) — long pole
- **Wave 5**: T7 (routes ← T6), T11 (client card ← T10)
- **Wave 6**: T9 (integration test ← T7)

Confirmed disjoint `files_to_touch` within every wave: the shared barrel `vendor/shared/index.ts`
is touched only by T1; `brief-synth.ts` authored only by T1; migrations dir only by T2. File
ownership is 1:1 per task to eliminate merge conflicts under parallel dispatch.

---

## Tasks

### T1 — Shared contract `brief-synth.ts`  · cross-cutting · depends_on: []
- **files_to_touch:** `server/src/vendor/shared/contracts/brief-synth.ts` (new); `server/src/vendor/shared/contracts/brief-synth.test.ts` (new); `server/src/vendor/shared/index.ts` (add export); `client/src/vendor/shared/contracts/brief-synth.ts` (new mirror); `client/src/vendor/shared/index.ts` (matching export)
- **description:** Define `PrWhyRiskBrief` (`what`, `why`, `riskLevel: RiskSeverity` — **import** from `./brief.js`, don't redefine — `risks: RiskArea[]`, `reviewFocus: ReviewFocusItem[]`, `model`, `cost{tokensIn,tokensOut,usd}`, `computedAt`, `basedOn{headSha,reviewId,intentComputedAt}`); `RiskArea` (`{icon: RiskAreaIcon, label, fileRef?:{file,line}}` — import `RiskAreaIcon` from `brief.js`); `ReviewFocusItem = z.object({findingId, note}).strict()` (**`.strict()` is required** — a plain `z.object` silently strips unknown keys, making AC-2's rejection test pass for the wrong reason); `PrWhyRiskBriefResponse` discriminated union on `status`; `staleReason = z.enum(['head_sha','new_review','intent'])`; missing-input `z.enum(['intent','review'])`. Mirror byte-for-byte into the client copy.
- **skills_to_apply:** `zod`, `typescript-expert`, `response-schema`, `breaking-change`, `semver-discipline`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-23 "vendor/shared/contracts... manual sync only"); `client/INSIGHTS.md` (2026-06-23 same)
- **test_command:** `cd server && pnpm exec vitest run src/vendor/shared/contracts/brief-synth.test.ts`
- **definition_of_done:** AC-1 (schema-shape test, all named fields incl. nested `cost`/`basedOn`); AC-2 (`.parse()` on an entry with an extra `file`/`line` key throws — proves strict rejection, not silent stripping).

### T2 — Migration: extend `pr_brief` (additive)  · server · depends_on: []
- **files_to_touch:** `server/src/db/schema/reviews.ts` (extend `prBrief` only); `server/src/db/migrations/00XX_*.sql` (generated); `server/src/db/migrations/meta/_journal.json` (generated); `server/src/db/migrations/meta/00XX_snapshot.json` (generated)
- **description:** Add `headSha text not null`, `reviewId uuid` FK→`reviews.id` `onDelete:'set null'`, `intentComputedAt timestamptz not null`, `riskLevel text not null`, `model text`, `promptTokens`/`completionTokens integer not null default 0`, `costUsd numeric(10,6) not null default 0`, `computedAt timestamptz not null defaultNow()`. `pnpm db:generate` must emit `ALTER TABLE "pr_brief" ADD COLUMN`, never `CREATE TABLE` (row already exists). Commit all THREE generated artifacts incl. the load-bearing `_journal.json` entry.
- **skills_to_apply:** `drizzle-orm-patterns`, `postgresql-table-design`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-23 "migration commits must include `meta/_journal.json`"; 2026-06-24 "Drizzle silently skips migrations whose journal `when` is earlier"; 2026-06-24 "snapshot chain broken at 0012/0013")
- **test_command:** `cd server && pnpm db:generate && rg -n 'ALTER TABLE "pr_brief"' src/db/migrations/*.sql && ! rg -n 'CREATE TABLE "pr_brief"' src/db/migrations/*.sql`
- **definition_of_done:** AC-37 — new migration contains `ALTER TABLE "pr_brief"`, never `CREATE TABLE`; `pnpm db:migrate` succeeds against a DB that ran the pre-existing 2-column `pr_brief` migration first.

### T3 — `assemble-input.ts` (input assembly, grounding safety, prompt file)  · server · depends_on: [T1]
- **files_to_touch:** `server/src/modules/overview/brief-synth/assemble-input.ts` (new); `.../assemble-input.test.ts` (new); `server/src/prompts/brief-synth.system.md` (new); `server/src/modules/pulls/routes.ts` (extract "latest review id for a PR" out of `computeFindingsByPr` into a shared exported helper — see Risk 1)
- **description:** `assembleBriefInput(container, workspaceId, prId)` gathers per Inputs(provenance): latest-review id via the extracted shared helper (AC-11); non-dismissed findings for that review (AC-8), each `rationale` clipped to a fixed char budget (AC-12, clipped not dropped); the `pr_intent` row; `container.repoIntel.getBlastRadius(repoId, changedFiles)` (existing method, new call site); diff stats via `composeSmartDiff` reused from `../../pulls/smart-diff/service.js`; attached-spec **paths/titles only** via the `attachedContextPaths`/`ContextService.listPaths` primitive `run-executor.ts` already uses (AC-6, no bodies). Assembled object contains **no** diff/patch field (AC-5). Every PR-derived text field wrapped as untrusted background content matching the clause authored in `brief-synth.system.md` (AC-13). **Do not** reference `platform/grounding.ts` — no free-text file:line output exists here to police.
- **skills_to_apply:** `onion-architecture`, `zod`, `security`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-19 "share `computeFindingsByPr` for latest-review consistency"; 2026-06-19 "`PrMeta.findings` required + adapter shims"; 2026-07-12 "clone-reading tests need a real-dir GitClient double"); `server/CLAUDE.md` (Onion; do-not-touch grounding.ts)
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/assemble-input.test.ts`
- **definition_of_done:** AC-5, AC-6, AC-8, AC-11, AC-12, AC-13 pass their named cases; `rg -n "untrusted" server/src/prompts/brief-synth.system.md` matches.

### T4 — `repository.ts` (`pr_brief` read/upsert)  · server · depends_on: [T1, T2]
- **files_to_touch:** `server/src/modules/overview/brief-synth/repository.ts` (new); `.../repository.test.ts` (new)
- **description:** `BriefSynthRepository.get(prId)` maps the extended `pr_brief` row → `PrWhyRiskBrief`+`basedOn`. `upsert(prId, key, dto)` uses `onConflictDoUpdate` listing **every** persisted column in `set` (mirrors `IntentRepository.upsert`) — no column silently left holding a prior value.
- **skills_to_apply:** `drizzle-orm-patterns`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-23 "`linkSkill` upsert silently dropped explicit `enabled`"; 2026-06-19 "`db.execute(sql\`\`)` returns the array directly")
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/repository.test.ts`
- **definition_of_done:** AC-38 — a second upsert with different values leaves no stale column.

### T5 — `synthesize.ts` (the one structured LLM call)  · server · depends_on: [T1, T3]
- **files_to_touch:** `server/src/modules/overview/brief-synth/synthesize.ts` (new); `.../synthesize.test.ts` (new)
- **description:** `synthesizeBrief(container, workspaceId, input)` resolves model via `container.resolveFeatureModel(workspaceId, 'risk_brief')` (AC-35), loads `brief-synth.system.md`, calls `llm.completeStructured` **once** with a Zod payload covering only `what/why/riskLevel/reviewFocus[]` — **not** `risks[]` (deterministic, built in T6). Mirrors `extract.ts` structure exactly.
- **skills_to_apply:** `zod`, `security`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-19 "Claude 4.x rejects `temperature`"; 2026-06-19 "structured-output reprompt needs `tool_result`"; 2026-07-04 "`withIdleTimeout` not a strict upgrade")
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/synthesize.test.ts`
- **definition_of_done:** contributes to AC-10 (exactly one `completeStructured` call, no follow-ups); AC-13 (loads `brief-synth.system.md`, distinct from Intent's); AC-35 (`rg` for `resolveFeatureModel(...'risk_brief')` matches).

### T6 — `service.ts` (state machine, rate limits, job handler, floor/cap/grounding, cost)  · server · depends_on: [T1, T2, T3, T4, T5]
- **files_to_touch:** `server/src/modules/overview/brief-synth/service.ts` (new); `.../service.test.ts` (new)
- **description:** `BriefSynthService` mirrors `IntentService` (independent in-memory rate-limit `Map`s, same numeric values 30/hr/workspace + 1/min/PR, AC-31). `getOrCompute` computes freshness key (`headSha`/latest-reviewId/`intent.computedAt`) vs cached `basedOn` → `not_ready`(AC-16..18, names missing `intent`/`review`, no cascade), `computing`(AC-19), `ready`(AC-20), `ready-stale`(deduped `staleReasons`, AC-21..24; served as-is, AC-25). `refresh` unconditionally enqueues (AC-27) but 4xx-rejects with no enqueue/no partial row when input missing (AC-28), rate-limited (AC-29, AC-30). Job handler: `assembleBriefInput` → `synthesizeBrief` once (AC-10) → drop unknown `findingId`s (AC-7) → cap `reviewFocus` at 8 preserving order (AC-9) → floor `riskLevel` to ≥`high` on blocker/critical, never lower (AC-14, AC-15) → build `risks[]` = `intent.riskAreas` verbatim + matched `fileRef` else `undefined`, never fabricated (AC-3, AC-4). Commit `repo.upsert` (all columns, AC-38) **and** an `agent_runs` row for **every** finish (reuse `createAgentRun`/`completeAgentRun`; `findingsCount`/`grounding` are review-specific — use sentinels e.g. `findingsCount:0`, `grounding:'n/a'`, AC-34), cost = most-recent call only (AC-36). Publish SSE `'done'` **only after** the DB write commits (AC-33), like `IntentService`.
- **skills_to_apply:** `onion-architecture`, `zod`, `security`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-24 "SSE 'done' emitted by the layer that commits the side effect"; 2026-07-12 "run reaches terminal status before its trace row is written"; 2026-07-12 "`pnpm typecheck` doesn't cover `test/**`")
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/service.test.ts`
- **definition_of_done:** AC-3, AC-4, AC-7, AC-9, AC-10, AC-14–18, AC-20–25, AC-27–31, AC-33–36 pass their named unit cases (route-level cases proven in T9).

### T7 — Routes: `GET brief-synth`, `POST refresh`, `GET stream`  · server · depends_on: [T6]
- **files_to_touch:** `server/src/modules/overview/routes.ts` (extend — add `briefSynthService` alongside `intentService`)
- **description:** Register `GET /pulls/:id/overview/brief-synth`, `POST /pulls/:id/overview/brief-synth/refresh` (202+`{runId}`; `RateLimitedError`/4xx bubble via existing `AppError`→HTTP mapping), `GET /pulls/:id/overview/brief-synth/stream?runId=…` (`config:{rateLimit:false}`, identical SSE bridging). Copy the Intent block's structure exactly, same file.
- **skills_to_apply:** `fastify-best-practices`, `zod`, `response-schema`, `breaking-change`, `semver-discipline`
- **insights_to_read:** `server/CLAUDE.md` (routes register Zod at boundary; external calls via adapters); `server/INSIGHTS.md` (2026-06-24 SSE done-ordering)
- **test_command:** `cd server && pnpm typecheck`
- **definition_of_done:** AC-26, AC-32 (routes exist, Zod-validated, typecheck green); behavioral proof of AC-19/27/28/33 is T9. Smoke `rg` confirms all three routes registered.

### T8 — Retire dormant `PrBrief` composite  · cross-cutting · depends_on: []
- **files_to_touch:** `server/src/vendor/shared/contracts/brief.ts` (remove only the `PrBrief` export block); `client/src/vendor/shared/contracts/brief.ts` (mirror removal)
- **description:** Delete `export const PrBrief = z.object({intent,blast,risks,history}); export type PrBrief = ...` from both. Do **not** touch `Intent`, `BlastRadius`, `Risk`/`Risks` (incl. `RiskSeverity`, which T1 imports), `PrHistory`, or `SmartDiff`* (live consumers in `pulls/smart-diff/`). `rg -n "\bPrBrief\b"` both repos first to confirm zero importers.
- **skills_to_apply:** `typescript-expert`, `breaking-change`, `deprecation-policy`, `semver-discipline`
- **insights_to_read:** `server/INSIGHTS.md` + `client/INSIGHTS.md` (2026-06-23 dual-copy sync)
- **test_command:** `cd server && pnpm typecheck && pnpm exec vitest run src/modules/pulls/smart-diff/service.test.ts && cd ../client && pnpm typecheck`
- **definition_of_done:** AC-39 — `rg -n "export const PrBrief" …/brief.ts` (both) returns nothing; both typechecks pass; `smart-diff/service.test.ts` unchanged-pass.

### T9 — Integration test: full state matrix + SSE + cost  · server · depends_on: [T7]
- **files_to_touch:** `server/test/overview-brief-synth.it.test.ts` (new)
- **description:** Docker-backed (`test/helpers/pg.ts`), end-to-end over real HTTP routes: no-intent→`not_ready`(AC-16, no job); no-review→`not_ready`(AC-17); both missing(AC-18); cold GET→`computing`+`runId`, drain, re-GET→`ready`(AC-19); warm fresh→`ready` no job(AC-20); head_sha drift(AC-21); newer review(AC-22); intent recomputed(AC-23); both drift, each once(AC-24); repeated GET on stale→same `computedAt`, no enqueue(AC-25); full matrix via one endpoint(AC-26); refresh on `ready` still enqueues(AC-27); refresh while missing→4xx, no job, table unchanged(AC-28); two refreshes <60s→429+`retryAfterSeconds`(AC-29); 31st in window→429(AC-30); brief budget exhaustion doesn't block Intent & vice versa(AC-31); SSE `info` then `done`(AC-32); DB row present at moment `done` observed(AC-33); `GET /pulls/:id/runs` includes new row(AC-34).
- **skills_to_apply:** `fastify-best-practices`, `drizzle-orm-patterns`, `security`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-07-12 terminal-before-trace; 2026-06-24 SSE done); `server/CLAUDE.md` (`*.it.test.ts` + `test/helpers/pg.ts`)
- **test_command:** `cd server && pnpm exec vitest run .it.test overview-brief-synth`
- **definition_of_done:** every AC case above passes.

### T10 — Client hook `useOverviewBriefSynth`  · client · depends_on: [T1]
- **files_to_touch:** `client/src/lib/hooks/overview.ts` (extend); `client/src/lib/hooks/overview.test.ts` (extend)
- **description:** Clone `useOverviewIntent` against `/pulls/:id/overview/brief-synth[/refresh|/stream]`, add net-new `not_ready`/`missing` status, bridge the refresh-POST's `runId` into its own `EventSource` — **do not** rely on `invalidateQueries` alone (documented POST+freshness-keyed-GET race; this is the exact "Brief refresh" case that insight named in advance).
- **skills_to_apply:** `react-best-practices`, `ui-architecture`, `typescript-expert`
- **insights_to_read:** `client/INSIGHTS.md` (2026-07-04 "POST /refresh + freshness-keyed GET race requires client-side SSE bridging"); `client/CLAUDE.md` (server state in TanStack Query hooks)
- **test_command:** `cd client && pnpm test overview.test.ts`
- **definition_of_done:** hook renders all 5 statuses; `refresh()` bridges `runId` into SSE and rejects with `ApiError` on 429 (supports AC-45 at hook layer).

### T11 — `WhyRiskBriefCard` + `OverviewTab.tsx` wiring  · client · depends_on: [T10]
- **files_to_touch:** `.../OverviewTab/_components/WhyRiskBriefCard/{WhyRiskBriefCard.tsx, WhyRiskBriefCard.test.tsx, styles.ts, index.ts}` (new); `.../OverviewTab/OverviewTab.tsx` (wire in); `client/messages/en/why-risk-brief.json` (new — see Risk 3)
- **description:** One visually distinct render per status (AC-40); name missing input(s) in `not_ready`(AC-41); disable/hide Refresh while `not_ready`(AC-42). "Review focus" = real ordered/keyboard-navigable list, resolving `file`/`line`/severity/title by `findingId` from `usePrReviews(prId)`'s already-fetched findings, click navigates via the `router.push(\`${baseHref}?tab=findings#finding-${id}\`)` pattern `FindingsCell` uses — no new endpoint (AC-43, AC-44). 429 on refresh → distinguishable "try again shortly" via captured `ApiError`, mirroring `IntentCard`(AC-45).
- **skills_to_apply:** `react-best-practices`, `react-testing-library`, `ui-architecture`, `next-best-practices`
- **insights_to_read:** `client/INSIGHTS.md` (2026-06-19 "`vi.mock('next/navigation')` needs `vi.hoisted`"); `client/CLAUDE.md` (tests next to file)
- **test_command:** `cd client && pnpm test WhyRiskBriefCard.test.tsx && pnpm typecheck`
- **definition_of_done:** AC-40–45 pass their named cases.

---

## AC → task coverage (all 45 mapped, no gaps)

| AC | Task(s) | AC | Task(s) | AC | Task(s) |
|---|---|---|---|---|---|
| AC-1 | T1 | AC-16 | T6, T9 | AC-31 | T6, T9 |
| AC-2 | T1 | AC-17 | T6, T9 | AC-32 | T7, T9 |
| AC-3 | T6 | AC-18 | T6, T9 | AC-33 | T6, T9 |
| AC-4 | T6 | AC-19 | T6, T7, T9 | AC-34 | T6, T9 |
| AC-5 | T3 | AC-20 | T6, T9 | AC-35 | T5, T6 |
| AC-6 | T3 | AC-21 | T6, T9 | AC-36 | T6 |
| AC-7 | T6 | AC-22 | T6, T9 | AC-37 | T2 |
| AC-8 | T3 | AC-23 | T6, T9 | AC-38 | T4 |
| AC-9 | T6 | AC-24 | T6, T9 | AC-39 | T8 |
| AC-10 | T5, T6 | AC-25 | T6, T9 | AC-40 | T11 |
| AC-11 | T3 | AC-26 | T7, T9 | AC-41 | T11 |
| AC-12 | T3 | AC-27 | T6, T7, T9 | AC-42 | T11 |
| AC-13 | T3, T5 | AC-28 | T6, T7, T9 | AC-43 | T11 |
| AC-14 | T6 | AC-29 | T6, T9 | AC-44 | T11 |
| AC-15 | T6 | AC-30 | T6, T9 | AC-45 | T10, T11 |

## Verification (end-to-end)
```
cd server && pnpm typecheck && pnpm exec vitest run --exclude '**/*.it.test.ts'
cd server && pnpm exec vitest run .it.test overview-brief-synth   # needs Docker
cd client && pnpm typecheck && pnpm test && pnpm build
```

## Risks / open questions (surfaced by the planner)
1. **AC-11 forces a small refactor of `pulls/routes.ts`** — extract the private "latest review id per PR" query into a shared exported helper both `computeFindingsByPr` and `assemble-input.ts` call. The letter of AC-11 ("shall not derive an independent definition") requires this; a hand-written equivalent-but-separate query would satisfy behavior but not the letter and re-introduce the drift the INSIGHTS entry warns about.
2. **`agent_runs.completeAgentRun` requires `findingsCount`/`grounding`** — review-specific fields with no meaning for a synthesis call. Proposed sentinels `findingsCount:0`, `grounding:'n/a'`; sanity-check how they render in any `agent_runs`-driven runs/cost UI before committing.
3. **i18n spec/codebase discrepancy (verified)** — the spec's Non-functional says new strings go "through i18n like every other Overview-tab string," but `IntentCard.tsx` and `PrBriefCard.tsx` are **not** i18n'd (hardcoded English). `next-intl` is used elsewhere (Settings, `VerdictBanner`). T11 does proper i18n regardless (no AC contradicts it), but the spec prose should be corrected.
4. **`sse-patterns` skill** was named as an example in the dispatch but the planner's catalogue lacked it; T7 pattern-matches the existing Intent-stream route instead. (It exists at orchestrator level — supply to the implementer for T6/T7/T10.)
5. **T6 is AC-dense (~24 ACs)** but file-small (2 files, mirrors `IntentService`). Safe internal split if context-pressured: state-machine+rate-limits first, job-handler body second — same file, two passes.

## Execution mode — recommendation: **multi**
No same-wave task pair shares a `files_to_touch` entry (verified). File ownership is 1:1, so the
user-named conflict risks (shared barrel, contract file, migrations dir) don't materialize. The
server critical path (T1→T3→T5→T6→T7→T9) is inherently sequential, but multi-agent still
collapses 11 tasks into 6 dispatch rounds (~45% fewer sequential steps) with zero conflict
exposure. Single-agent is only preferable if a single linear reviewable commit sequence is
wanted over wall-clock.
