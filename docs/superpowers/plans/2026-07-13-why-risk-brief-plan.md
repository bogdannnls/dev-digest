# Development Plan: Why + Risk Brief

- **Source spec:** [`specs/2026-07-13-why-risk-brief-spec.md`](../../../specs/2026-07-13-why-risk-brief-spec.md) — SPEC-02 (45 EARS ACs, approved)
- **Design:** [`docs/superpowers/specs/2026-07-13-why-risk-brief-design.md`](../specs/2026-07-13-why-risk-brief-design.md)
- **execution_mode:** `multi` *(confirmed by user 2026-07-13)*
- **Author:** `implementation-planner`, then revised 2026-07-13 per staff-engineer plan review (advisor: REQUEST_CHANGES → all blockers resolved below)
- **Date:** 2026-07-13

> Consumed by the `implementer` agent via `/sdd`. Every task's `definition_of_done` traces to
> specific AC ids in SPEC-02. All 45 ACs are covered (see the coverage table); no gaps.
>
> **Revision note (post-review):** C1/H1 rewrote T2 (hand-authored migration — `db:generate`
> is broken in this repo, see INSIGHTS 2026-06-24); H2 corrected the `riskLevel` floor to reuse
> the case-insensitive `BLOCKER_SEVERITIES` set (real severities are `CRITICAL/WARNING/SUGGESTION`,
> there is no `blocker`); M1 added `client/src/lib/types.ts` to T8; M2 moved `agent_runs` row
> creation to enqueue time; M5 split the pure post-processing into new task **T12**.

## Goal
Add a second, thin LLM pass that **composes** already-computed PR artifacts (Intent,
`RepoIntel.getBlastRadius`, latest-review findings, `SmartDiff`, attached-spec paths) into one
synthesized brief — a one-sentence what/why, a deterministically-floored risk level, and a
"Review focus — read these first" list grounded in real finding ids (never model-emitted
file:line). Read-through cached in the already-existing (zero-consumer) `pr_brief` table via an
additive migration, exposed as a new Overview-tab endpoint trio (`GET`, `POST /refresh`,
`GET /stream`) mirroring the Intent layer, rendered as a new `WhyRiskBriefCard`. The dormant
`PrBrief` composite is retired in the same effort, without touching its still-used
building-block schemas.

## In scope
- New shared contract `brief-synth.ts` (server + client mirror).
- Additive **hand-authored** migration extending `pr_brief` (never `CREATE TABLE`, never `db:generate`).
- `server/src/modules/overview/brief-synth/` — input assembly, LLM call, pure post-processing, repository, service, routes.
- Retirement of the dormant `PrBrief` composite from `contracts/brief.ts` (both copies + `client/src/lib/types.ts`).
- Client hook `useOverviewBriefSynth` + `WhyRiskBriefCard` + `OverviewTab.tsx` wiring.
- Integration test covering the full 5-state matrix + SSE + cost/rate-limit behavior.

## Out of scope
- Any new Blast Radius UI panel/route (blast is an LLM input only — Non-goal).
- Re-computation of intent, blast radius, findings, or smart-diff.
- Semantic spec retrieval (attached-context paths only).
- Wiring `platform/grounding.ts`'s citation gate onto this call (Non-functional forbids it).
- Auto-regeneration cascade of intent/review from `not_ready`.
- Retrofitting `IntentCard`/`PrBriefCard` for i18n (follow-up, see Risk 3).

## Dependency waves
- **Wave 1** (no deps, disjoint files): T1 (contract), T2 (migration), T8 (retire `PrBrief`)
- **Wave 2**: T3 (assemble-input ← T1), T4 (repository ← T1+T2), T10 (client hook ← T1), **T12 (postprocess ← T1)**
- **Wave 3**: T5 (synthesize ← T1+T3)
- **Wave 4**: T6 (service ← T1+T2+T3+T4+T5+T12) — long pole
- **Wave 5**: T7 (routes ← T6), T11 (client card ← T10)
- **Wave 6**: T9 (integration test ← T7)

Verified no same-wave task pair shares a `files_to_touch` entry (incl. new T12, which owns only
`postprocess.ts[.test]`). File ownership is 1:1.

---

## Tasks

### T1 — Shared contract `brief-synth.ts`  · cross-cutting · depends_on: []
- **files_to_touch:** `server/src/vendor/shared/contracts/brief-synth.ts` (new); `server/src/vendor/shared/contracts/brief-synth.test.ts` (new); `server/src/vendor/shared/index.ts` (add export); `client/src/vendor/shared/contracts/brief-synth.ts` (new mirror); `client/src/vendor/shared/index.ts` (matching export)
- **description:** Define `PrWhyRiskBrief` (`what`, `why`, `riskLevel: RiskSeverity` — **import** from `./brief.js`, don't redefine — `risks: RiskArea[]`, `reviewFocus: ReviewFocusItem[]`, `model`, `cost{tokensIn,tokensOut,usd}`, `computedAt`, `basedOn{headSha,reviewId,intentComputedAt}`); `RiskArea` (`{icon: RiskAreaIcon, label, fileRef?:{file,line}}` — import `RiskAreaIcon` from `brief.js`); `ReviewFocusItem = z.object({findingId, note}).strict()` (**`.strict()` is required** — a plain `z.object` silently strips unknown keys, making AC-2's rejection test pass for the wrong reason); `PrWhyRiskBriefResponse` discriminated union on `status`; `staleReason = z.enum(['head_sha','new_review','intent'])`; missing-input `z.enum(['intent','review'])`. Mirror byte-for-byte into the client copy. **Note (L6):** `client/src/vendor/` is marked do-not-touch in `client/CLAUDE.md`, but manual server↔client contract sync is the established norm (the Intent contracts set the precedent) — this edit is expected, proceed.
- **skills_to_apply:** `zod`, `typescript-expert`, `response-schema`, `breaking-change`, `semver-discipline`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-23 "vendor/shared/contracts... manual sync only"); `client/INSIGHTS.md` (2026-06-23 same)
- **test_command:** `cd server && pnpm exec vitest run src/vendor/shared/contracts/brief-synth.test.ts`
- **definition_of_done:** AC-1 (schema-shape test, all named fields incl. nested `cost`/`basedOn`); AC-2 (`.parse()` on an entry with an extra `file`/`line` key throws — proves strict rejection, not silent stripping).

### T2 — Migration: extend `pr_brief` (additive, HAND-AUTHORED)  · server · depends_on: []
- **files_to_touch:** `server/src/db/schema/reviews.ts` (extend `prBrief` only); `server/src/db/migrations/0017_extend_pr_brief.sql` (**hand-authored**); `server/src/db/migrations/meta/_journal.json` (append one entry)
- **description:** **Do NOT run `pnpm db:generate`** — the Drizzle snapshot chain is broken at 0012/0013 and there are no snapshots for 0014–0016; `db:generate` aborts or emits a garbage diff (INSIGHTS 2026-06-24, lines 105-113, cited below). Follow the repo's established workaround: (1) extend the `prBrief` table in `reviews.ts` with `headSha text not null`, `reviewId uuid` FK→`reviews.id` `onDelete:'set null'`, `intentComputedAt timestamptz not null`, `riskLevel text not null`, `model text`, `promptTokens`/`completionTokens integer not null default 0`, `costUsd numeric(10,6) not null default 0`, `computedAt timestamptz not null defaultNow()`; (2) hand-write `0017_extend_pr_brief.sql` as `ALTER TABLE "pr_brief" ADD COLUMN ...`, mirroring `0015_pr_intent_overview.sql`'s style (add NOT-NULL columns with a temporary default, then `DROP DEFAULT` where the column should not carry one); (3) append ONE `_journal.json` entry with `idx: 17` and `when` = a **current** epoch-ms strictly greater than 0016's `1783808223391` (INSIGHTS 2026-06-24: any `when` ≤ the last-applied timestamp is silently skipped forever). **Do NOT write a `meta/0017_snapshot.json`** — the chain is already broken; the runtime applier reads only journal + SQL.
- **skills_to_apply:** `drizzle-orm-patterns`, `postgresql-table-design`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-24 "snapshot chain broken at 0012/0013, blocking `db:generate`"; 2026-06-24 "hand-authored migration `when` must be strictly greater than every prior entry"; 2026-06-23 "journal is load-bearing")
- **test_command:** `cd server && pnpm db:migrate && rg -n 'ALTER TABLE "pr_brief"' src/db/migrations/0017_extend_pr_brief.sql && ! rg -n 'CREATE TABLE' src/db/migrations/0017_extend_pr_brief.sql` *(rg scoped to the NEW file only — `0000_init.sql` legitimately contains `CREATE TABLE "pr_brief"`)*
- **definition_of_done:** AC-37 — `0017_extend_pr_brief.sql` ALTERs `pr_brief` (never CREATE); its journal `when` is strictly greater than `1783808223391`; `pnpm db:migrate` succeeds end-to-end on a DB that already ran 0000–0016.

### T3 — `assemble-input.ts` (input assembly, grounding safety, prompt file)  · server · depends_on: [T1]
- **files_to_touch:** `server/src/modules/overview/brief-synth/assemble-input.ts` (new); `.../assemble-input.test.ts` (new); `server/src/prompts/brief-synth.system.md` (new); `server/src/modules/pulls/latest-review.ts` (**new** — extract the "latest review id for a PR" query here; update `computeFindingsByPr` in `pulls/routes.ts` to import it) *(L2: a new sibling module, not importing the overview layer from another module's route file)*
- **description:** `assembleBriefInput(container, workspaceId, prId)` gathers per Inputs(provenance): latest-review id via the extracted shared helper (AC-11); non-dismissed findings for that review (AC-8), each `rationale` clipped to a fixed char budget (AC-12, clipped not dropped); the `pr_intent` row; `container.repoIntel.getBlastRadius(repoId, changedFiles)` (existing method, new call site); diff stats via `composeSmartDiff` reused from `../../pulls/smart-diff/service.js`; attached-spec **paths + titles only** — **title = file basename for v1** (no heading parse); **if the latest review's `agentId` is null** (agents are deletable, FK nullable), the attached-context set is empty (M4). Assembled object contains **no** diff/patch field (AC-5) and **no** doc bodies (AC-6). Every PR-derived text field wrapped as untrusted background content matching the clause authored in `brief-synth.system.md` (AC-13). **Do not** reference `platform/grounding.ts` — no free-text file:line output exists here to police.
- **skills_to_apply:** `onion-architecture`, `zod`, `security`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-19 "share `computeFindingsByPr` for latest-review consistency"; 2026-06-19 "`PrMeta.findings` required + adapter shims"; 2026-07-12 "clone-reading tests need a real-dir GitClient double"); `server/CLAUDE.md` (Onion; do-not-touch grounding.ts)
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/assemble-input.test.ts`
- **definition_of_done:** AC-5, AC-6, AC-8, AC-11, AC-12, AC-13 pass their named cases; `rg -n "untrusted" server/src/prompts/brief-synth.system.md` matches.

### T4 — `repository.ts` (`pr_brief` read/upsert)  · server · depends_on: [T1, T2]
- **files_to_touch:** `server/src/modules/overview/brief-synth/repository.ts` (new); `.../repository.test.ts` (new)
- **description:** `BriefSynthRepository.get(prId)` maps the extended `pr_brief` row → `PrWhyRiskBrief`+`basedOn` (handle a **null `reviewId`** — review deletion sets it null, L1). `upsert(prId, key, dto)` uses `onConflictDoUpdate` listing **every** persisted column in `set` (mirrors `IntentRepository.upsert`) — no column silently left holding a prior value.
- **skills_to_apply:** `drizzle-orm-patterns`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-23 "`linkSkill` upsert silently dropped explicit `enabled`"; 2026-06-19 "`db.execute(sql\`\`)` returns the array directly")
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/repository.test.ts`
- **definition_of_done:** AC-38 — the unit test asserts **set-clause completeness structurally** (no Postgres in unit scope, L4); real on-conflict overwrite behavior is proven end-to-end by T9's AC-36 two-refresh case.

### T5 — `synthesize.ts` (the one structured LLM call)  · server · depends_on: [T1, T3]
- **files_to_touch:** `server/src/modules/overview/brief-synth/synthesize.ts` (new); `.../synthesize.test.ts` (new)
- **description:** `synthesizeBrief(container, workspaceId, input)` resolves model via `container.resolveFeatureModel(workspaceId, 'risk_brief')` (AC-35), loads `brief-synth.system.md`, calls `llm.completeStructured` **once** with a Zod payload covering only `what/why/riskLevel/reviewFocus[]` — **not** `risks[]` (deterministic, built in T12). Mirrors `extract.ts` structure exactly.
- **skills_to_apply:** `zod`, `security`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-19 "Claude 4.x rejects `temperature`"; 2026-06-19 "structured-output reprompt needs `tool_result`"; 2026-07-04 "`withIdleTimeout` not a strict upgrade")
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/synthesize.test.ts`
- **definition_of_done:** contributes to AC-10 (exactly one `completeStructured` call, no follow-ups); AC-13 (loads `brief-synth.system.md`, distinct from Intent's); AC-35 (`rg` for `resolveFeatureModel(...'risk_brief')` matches).

### T12 — `postprocess.ts` (pure deterministic post-processing) · server · depends_on: [T1]
- **files_to_touch:** `server/src/modules/overview/brief-synth/postprocess.ts` (new); `.../postprocess.test.ts` (new)
- **description:** Pure, IO-free, no-LLM functions over the model output + the input finding/intent set (split out of T6 per review M5 — this is the correctness heart of the feature and deserves isolated tests): (1) **drop** any `reviewFocus[].findingId` not present in the input finding set (AC-7); (2) **cap** `reviewFocus` at 8, preserving the model's order, index 0 = read first (AC-9); (3) **floor** `riskLevel` to at least `'high'` when any input finding's severity is blocker-tier — **reuse the existing case-insensitive `BLOCKER_SEVERITIES` semantics** from `server/src/modules/overview/brief/aggregate.ts` (`new Set(['blocker','critical'])` matched via `.toLowerCase()`; real severities are `CRITICAL/WARNING/SUGGESTION`, so this fires on `'CRITICAL'`) — never lower a higher model value (AC-14, AC-15); (4) **build `risks[]`** = `intent.riskAreas` verbatim (icon/label unchanged, AC-3) with `fileRef` attached by a **deterministic v1 rule**: pick the file:line of the highest-severity non-dismissed finding whose `file` path or `category` case-insensitively contains a token of the risk-area `label`; if none matches, `fileRef` is `undefined` — never fabricated (AC-4). *(v1 heuristic — an explicit decision, not an accident; refinable later.)*
- **skills_to_apply:** `zod`, `typescript-expert`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-19 blocker-severity handling in `aggregate.ts`)
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/postprocess.test.ts`
- **definition_of_done:** AC-3, AC-4, AC-7, AC-9, AC-14 (real `'CRITICAL'` row → floored to `high`), AC-15 (only `WARNING`/`SUGGESTION` → model value preserved) all pass isolated unit cases.

### T6 — `service.ts` (state machine, rate limits, job handler, cost)  · server · depends_on: [T1, T2, T3, T4, T5, T12]
- **files_to_touch:** `server/src/modules/overview/brief-synth/service.ts` (new); `.../service.test.ts` (new); DI wiring in `server/src/platform/container.ts` if the service needs a container slot (mirror how `IntentService` is constructed)
- **description:** `BriefSynthService` mirrors `IntentService` (independent in-memory rate-limit `Map`s, same numeric values 30/hr/workspace + 1/min/PR, AC-31; **keep the injectable `now` ctor param** the Intent service has — needed for AC-30 rate-limit testing without a real clock, L3). `getOrCompute` computes the freshness key (`headSha`/latest-reviewId/`intent.computedAt`) vs the cached `basedOn` → `not_ready`(AC-16..18, names missing `intent`/`review`, no cascade), `computing`(AC-19), `ready`(AC-20), `ready-stale`(deduped `staleReasons`, AC-21..24; served as-is, AC-25). Staleness comparison tolerates a **null cached `reviewId`** (L1). `refresh` unconditionally enqueues (AC-27) but 4xx-rejects with no enqueue/no partial row when intent or a qualifying review is missing (AC-28), rate-limited (AC-29, AC-30). **`agent_runs` row is created at ENQUEUE time** (mirror `reviews/service.ts` — `createAgentRun` mints the id) and **that id is the runId** returned to the client and used on the bus/SSE, so `GET /pulls/:id/runs` shows a row attributable to this exact run (M2/AC-34); `completeAgentRun` runs on **both** success and failure. Job handler: `assembleBriefInput` (T3) → `synthesizeBrief` once (T5, AC-10) → **all deterministic post-processing via T12's `postprocess.ts`** (findingId drop, cap-8, riskLevel floor, risks/fileRef). Commit `repo.upsert` (all columns, T4/AC-38); cost persisted = most-recent call only (AC-36). Publish SSE `'done'` **only after** the DB write commits (AC-33), like `IntentService`.
- **skills_to_apply:** `onion-architecture`, `zod`, `security`, `typescript-expert`, `sse-patterns`
- **insights_to_read:** `server/INSIGHTS.md` (2026-06-24 "SSE 'done' emitted by the layer that commits the side effect"; 2026-07-12 "run reaches terminal status before its trace row is written"; 2026-07-12 "`pnpm typecheck` doesn't cover `test/**`")
- **test_command:** `cd server && pnpm exec vitest run src/modules/overview/brief-synth/service.test.ts`
- **definition_of_done:** AC-10, AC-16, AC-17, AC-18, AC-20, AC-21, AC-22, AC-23, AC-24, AC-25, AC-27, AC-28, AC-29, AC-30, AC-31, AC-33, AC-34, AC-35, AC-36 pass their named unit cases (route-level cases proven in T9; deterministic post-processing owned by T12).

### T7 — Routes: `GET brief-synth`, `POST refresh`, `GET stream`  · server · depends_on: [T6]
- **files_to_touch:** `server/src/modules/overview/routes.ts` (extend — add `briefSynthService` alongside `intentService`)
- **description:** Register `GET /pulls/:id/overview/brief-synth`, `POST /pulls/:id/overview/brief-synth/refresh` (202+`{runId}`; `RateLimitedError`/4xx bubble via existing `AppError`→HTTP mapping), `GET /pulls/:id/overview/brief-synth/stream?runId=…` (`config:{rateLimit:false}`, identical SSE bridging). Copy the Intent block's structure exactly, same file.
- **skills_to_apply:** `fastify-best-practices`, `zod`, `response-schema`, `breaking-change`, `semver-discipline`, `sse-patterns`
- **insights_to_read:** `server/CLAUDE.md` (routes register Zod at boundary; external calls via adapters); `server/INSIGHTS.md` (2026-06-24 SSE done-ordering)
- **test_command:** `cd server && pnpm typecheck`
- **definition_of_done:** AC-26, AC-32 (routes exist, Zod-validated, typecheck green); behavioral proof of AC-19/27/28/33 is T9. Smoke `rg` confirms all three routes registered.

### T8 — Retire dormant `PrBrief` composite  · cross-cutting · depends_on: []
- **files_to_touch:** `server/src/vendor/shared/contracts/brief.ts` (remove only the `PrBrief` export block); `client/src/vendor/shared/contracts/brief.ts` (mirror removal); **`client/src/lib/types.ts` (M1 — drop only `PrBrief` from the `export type { PrBrief, SmartDiff } from "@devdigest/shared";` re-export line; `SmartDiff` stays)**
- **description:** Delete `export const PrBrief = z.object({intent,blast,risks,history}); export type PrBrief = ...` from both contract files, and remove `PrBrief` from the `client/src/lib/types.ts:35` re-export. Do **not** touch `Intent`, `BlastRadius`, `Risk`/`Risks` (incl. `RiskSeverity`, which T1 imports), `PrHistory`, or `SmartDiff`* (live consumers in `pulls/smart-diff/`). `rg -n "\bPrBrief\b"` both repos first to confirm no remaining importers beyond `types.ts`. **Note (L6):** touching `client/src/vendor/` is expected (see T1 note).
- **skills_to_apply:** `typescript-expert`, `breaking-change`, `deprecation-policy`, `semver-discipline`
- **insights_to_read:** `server/INSIGHTS.md` + `client/INSIGHTS.md` (2026-06-23 dual-copy sync)
- **test_command:** `cd server && pnpm typecheck && pnpm exec vitest run src/modules/pulls/smart-diff/service.test.ts && cd ../client && pnpm typecheck`
- **definition_of_done:** AC-39 — `rg -n "export const PrBrief" …/brief.ts` (both) returns nothing; no remaining `PrBrief` importer; both typechecks pass; `smart-diff/service.test.ts` unchanged-pass.

### T9 — Integration test: full state matrix + SSE + cost  · server · depends_on: [T7]
- **files_to_touch:** `server/test/overview-brief-synth.it.test.ts` (new)
- **description:** Docker-backed (`test/helpers/pg.ts`), end-to-end over real HTTP routes: no-intent→`not_ready`(AC-16, no job); no-review→`not_ready`(AC-17); both missing(AC-18); cold GET→`computing`+`runId`, drain, re-GET→`ready`(AC-19); warm fresh→`ready` no job(AC-20); head_sha drift(AC-21); newer review(AC-22); intent recomputed(AC-23); both drift, each once(AC-24); repeated GET on stale→same `computedAt`, no enqueue(AC-25); full matrix via one endpoint(AC-26); refresh on `ready` still enqueues(AC-27); refresh while missing→4xx, no job, table unchanged(AC-28); two refreshes <60s→429+`retryAfterSeconds`(AC-29); **31st compute/refresh in window→429 — seed ~31 PRs or drive the service with its injectable `now`, since the 1/min/PR limit blocks single-PR loops (L3)**(AC-30); brief budget exhaustion doesn't block Intent & vice versa(AC-31); SSE `info` then `done`(AC-32); DB row present at moment `done` observed(AC-33); `GET /pulls/:id/runs` includes new row with the refresh-returned `runId`(AC-34); a **deleted review** (null cached `reviewId`) still yields a coherent staleness verdict(L1). Optional soft, non-failing timing log for the ~15s `computing→ready` target (planner rec 2).
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
- **files_to_touch:** `.../OverviewTab/_components/WhyRiskBriefCard/{WhyRiskBriefCard.tsx, WhyRiskBriefCard.test.tsx, styles.ts, index.ts}` (new); `.../OverviewTab/OverviewTab.tsx` (wire in); `client/messages/en/whyRiskBrief.json` (**new — camelCase to match existing namespaces** `agentPerformance.json`/`prReview.json`, L5)
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
| AC-3 | **T12** | AC-18 | T6, T9 | AC-33 | T6, T9 |
| AC-4 | **T12** | AC-19 | T6, T7, T9 | AC-34 | T6, T9 |
| AC-5 | T3 | AC-20 | T6, T9 | AC-35 | T5, T6 |
| AC-6 | T3 | AC-21 | T6, T9 | AC-36 | T6 |
| AC-7 | **T12** | AC-22 | T6, T9 | AC-37 | T2 |
| AC-8 | T3 | AC-23 | T6, T9 | AC-38 | T4, T9 |
| AC-9 | **T12** | AC-24 | T6, T9 | AC-39 | T8 |
| AC-10 | T5, T6 | AC-25 | T6, T9 | AC-40 | T11 |
| AC-11 | T3 | AC-26 | T7, T9 | AC-41 | T11 |
| AC-12 | T3 | AC-27 | T6, T7, T9 | AC-42 | T11 |
| AC-13 | T3, T5 | AC-28 | T6, T7, T9 | AC-43 | T11 |
| AC-14 | **T12** | AC-29 | T6, T9 | AC-44 | T11 |
| AC-15 | **T12** | AC-30 | T6, T9 | AC-45 | T10, T11 |

## Verification (end-to-end)
```
cd server && pnpm typecheck && pnpm exec vitest run --exclude '**/*.it.test.ts'
cd server && pnpm db:migrate && pnpm exec vitest run .it.test overview-brief-synth   # needs Docker
cd client && pnpm typecheck && pnpm test && pnpm build
```

## Review resolutions (advisor plan review, 2026-07-13)
- **C1 (Critical, fixed):** T2 no longer runs `db:generate` (broken chain); hand-authors `0017_extend_pr_brief.sql` + journal entry, no snapshot.
- **H1 (fixed):** T2 `rg` checks scoped to the new migration file (`0000_init.sql` legitimately has `CREATE TABLE "pr_brief"`).
- **H2 (fixed, spec + plan):** `riskLevel` floor reuses case-insensitive `BLOCKER_SEVERITIES`; real severities are `CRITICAL/WARNING/SUGGESTION` (no `blocker`). Spec AC-14/15/US-3 corrected.
- **M1 (fixed):** T8 adds `client/src/lib/types.ts` (drop only `PrBrief`).
- **M2 (folded):** `agent_runs` row created at enqueue time; its id is the runId (reviews pattern) → AC-34 attributable.
- **M3 (folded):** T12 defines a deterministic v1 `fileRef` matching rule (explicit decision).
- **M4 (folded):** T3 sets title = basename, null-agent ⇒ empty attached set.
- **M5 (folded):** pure post-processing split into T12 (parallel in wave 2), shrinking the T6 long pole.
- **L1/L2/L3/L4/L5/L6 (folded):** null `reviewId` handling; helper in `pulls/latest-review.ts`; injectable `now` for rate-limit tests; structural upsert unit test; camelCase i18n filename; vendor-dir edit expectation noted.

## Remaining risks
- **T6 is still the densest task (~19 ACs after the T12 split)** but is now pure-logic-free (all deterministic post-processing lives in T12). Safe internal split if context-pressured: state-machine + rate-limits first, job-handler wiring second — same file.
- **`fileRef` v1 heuristic (T12)** may attach a loosely-related finding to a risk area; it's deterministic and test-covered, and refinable without a contract change (`fileRef?` is optional).

## Execution mode: **multi** (confirmed)
No same-wave task pair shares a `files_to_touch` entry (verified, incl. T12). File ownership is
1:1. Server critical path (T1→T3→T5→T6→T7→T9) is inherently sequential; multi-agent collapses
12 tasks into 6 dispatch rounds with zero conflict exposure.
