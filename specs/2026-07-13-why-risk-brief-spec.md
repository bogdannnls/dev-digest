# Spec: Why + Risk Brief | Spec ID: SPEC-02 | Status: draft
Supersedes: the dormant `PrBrief` composite in `server/src/vendor/shared/contracts/brief.ts`
and its client mirror `client/src/vendor/shared/contracts/brief.ts` (retired by AC-39; its
still-used building-block schemas are NOT touched — see AC-39 and Open questions).
Modules: server, client

## Problem & why

The PR Overview tab already renders most of the target mockup from **already-shipped**
pieces: the top verdict card (`PrOverviewBrief` — pure aggregation, no LLM), the Intent
panel (goal, in/out of scope, risk-area chips — `PrIntentDto`, cached + SSE + refresh), and
Smart Diff's file grouping. The one genuinely missing piece is a synthesized top-of-page
narrative plus a prioritized **"Review focus — read these first"** list, grounded in real
findings. This feature adds that as a thin second LLM pass that **composes** already-computed
artifacts — it does not recompute intent, blast radius, findings, or smart-diff.

Full architecture, decisions, data flow, and rationale are in the approved design:
[`docs/superpowers/specs/2026-07-13-why-risk-brief-design.md`](../docs/superpowers/specs/2026-07-13-why-risk-brief-design.md).
This spec restates that design as testable, implementation-free acceptance criteria, and
corrects three assumptions the design doc made that no longer match the current codebase
(discovered during this spec's design-analysis pass — each resolved as a decision below,
not silently guessed):

1. **`pr_brief` is not a new table.** It already exists (`server/src/db/schema/reviews.ts`,
   present since the initial schema snapshot), shaped `{ pr_id (PK), json }`, with zero
   production consumers — it was evidently reserved for the now-retired `PrBrief`
   composite. This feature's migration must **extend** that table (`ALTER TABLE`), the same
   way `0015_pr_intent_overview.sql` extended `pr_intent` — never `CREATE TABLE pr_brief`,
   which would collide with the existing relation. See AC-37 and Interfaces & flows.
2. **There is no `run_cost` table.** The schema has no such relation; cost is either
   persisted directly on a cache row (`pr_intent.cost_usd`, the pattern this feature
   mirrors) or computed on read from `agent_runs.tokensIn/tokensOut` via `PriceBook`
   (the pattern `PrOverviewBrief`'s aggregation uses). "Records an `agent_run` with a
   `run_cost` row" in the design doc is restated precisely as AC-34: persist an
   `agent_runs` row; the brief's own `cost` field is populated from that same call's
   token/price data, mirroring `pr_intent`'s columns.
3. **Blast radius has no existing Overview-tab surface to "reuse" from.** `OverviewTab.tsx`
   today renders only the verdict card, `IntentCard`, and the PR description — there is no
   `BlastRadiusCard` and no `/overview/blast` route. The actual computation is a real,
   working capability (`RepoIntel.getBlastRadius(repoId, changedFiles)`, best-effort/
   degraded-safe), separate from the MCP `get_blast_radius` tool (an unimplemented stub).
   This feature is the **first** caller wiring that facade method into the Overview module;
   it is `[reused: existing capability]`, not `[reused: existing Overview endpoint]`. See
   Inputs (provenance) and Interfaces & flows. Non-goal "no recomputation of blast radius"
   still holds — this feature calls the existing facade method as-is, it does not build a
   new blast-radius algorithm.

## Goals / Non-goals

**Goals**
- Produce a synthesized `{what, why, riskLevel, risks[], reviewFocus[]}` brief for a PR
  from pre-computed inputs, in one structured LLM call.
- `reviewFocus[]` is grounded in real findings by id — never a model-emitted file:line —
  making a citation-gate bypass structurally impossible for this call.
- `riskLevel` is LLM-assigned but deterministically floored: any blocker/critical finding
  in the input set forces `riskLevel` to at least `'high'`.
- Cost and tokens for the synthesis call are tracked and displayed, consistent with other
  LLM-backed cards (Intent, reviews).
- Read-through cache with staleness detection (`head_sha`, `new_review`, `intent` drift) and
  a manual regenerate action, mirroring the Intent layer's proven pattern.
- Retire the dormant `PrBrief` composite contract without touching its still-used
  building-block schemas.

**Non-goals**
- No re-computation of intent, blast radius, findings, or smart-diff — this feature composes
  them; it does not re-run or re-derive any of those upstream computations.
- No raw diff bodies sent to the model, in any form.
- No new review/analysis pass — findings come only from the review(s) that already ran.
- No semantic spec retrieval — "relevant specs" means the reviewing agent's already-attached
  context paths (deterministic), not a new search/ranking step.
- No auto-regeneration cascade — a missing intent or review yields `not_ready`, never a
  background recompute of those upstream layers.
- No new client-rendered "Blast Radius" panel — blast data is consumed only as an LLM input
  for this feature's synthesis call, not surfaced as its own Overview-tab card (that is
  separate, out-of-scope future work).

## User stories

- **US-1** — As a reviewer opening a PR's Overview tab, I see a synthesized one-sentence
  what/why narrative summarizing the PR without re-reading the raw diff myself.
- **US-2** — As a reviewer, I see a "Review focus — read these first" numbered list of the
  highest-priority findings, each linking to its file:line, so I know where to start.
- **US-3** — As a reviewer, I see an overall risk level for the PR that never under-rates a
  PR containing a blocker or critical finding, regardless of what the model itself assigns.
- **US-4** — As a reviewer, I see the cost and token usage of the synthesis call, consistent
  with how other LLM-backed cards on this tab show their cost.
- **US-5** — As a reviewer, I can manually refresh the brief when the PR has moved on (new
  commits, a new review, or a recomputed intent), and I'm told specifically why it's stale.
- **US-6** — As a reviewer, when intent or a review isn't ready yet, I'm told clearly which
  input is missing rather than seeing a broken/empty card or triggering a silent cascade
  recompute of intent or the review.
- **US-7** — As an operator, no raw diff content and no full attached-context document
  bodies ever leave the server boundary into this model call — only paths/titles and
  already-computed summaries, all wrapped as untrusted background content.
- **US-8** — As an operator, I'm protected against runaway compute cost by rate limits
  independent of, but numerically consistent with, the Intent layer's.
- **US-9** — As a developer, the dormant `PrBrief` composite contract is removed so there's
  no future ambiguity between it, `PrOverviewBrief`, and the new `PrWhyRiskBrief`; the
  existing `pr_brief` table is finally given a real consumer via an additive migration.
- **US-10** — As a reviewer, if the model references a finding id that doesn't exist in the
  set it was given, I never see a broken or nonsensical review-focus entry.

## Acceptance criteria (EARS)

**Contract shape**

- AC-1. The system shall define `PrWhyRiskBrief` with fields `what`, `why`, `riskLevel`,
  `risks[]`, `reviewFocus[]`, `model`, `cost {tokensIn, tokensOut, usd}`, `computedAt`, and
  `basedOn {headSha, reviewId, intentComputedAt}`. (traces: US-1, US-3, US-4) (verify:
  `server/src/vendor/shared/contracts/brief-synth.test.ts` — new schema-shape test; mirrored
  in `client/src/vendor/shared/contracts/brief-synth.ts`)
- AC-2. The system shall represent each `reviewFocus[]` entry as exactly `{ findingId, note
  }` — the model never emits a file path or line number in this call's output. (traces:
  US-2, US-7, US-10) (verify: `brief-synth.test.ts` — schema rejects an entry containing a
  `file`/`line` field)
- AC-3. The system shall populate `risks[]` as the PR's `intent.riskAreas` reused verbatim
  (same `icon`/`label` values, not re-derived by the synthesis call), with each entry
  optionally carrying a server-attached `fileRef { file, line }`. (traces: US-3) (verify:
  `server/src/modules/overview/brief-synth/service.test.ts` — new case asserting `risks[]`
  equals the PR's cached `intent.riskAreas` by value)
- AC-4. IF no finding or blast caller can be matched to a given risk area, THEN the system
  shall omit that risk area's `fileRef` rather than fabricate one. (traces: US-3, US-7)
  (verify: `service.test.ts` — new case: a risk area with no matching finding/caller yields
  `fileRef: undefined`)

**Input assembly & grounding safety**

- AC-5. The system shall exclude PR diff body content, in any form, from the synthesis
  call's input. (traces: US-7) (verify: `server/src/modules/overview/brief-synth/
  assemble-input.test.ts` — new case asserting the assembled input contains no diff/patch
  field)
- AC-6. The system shall pass attached context documents to the synthesis call as
  path-and-title pairs only, never document body content. (traces: US-7) (verify:
  `assemble-input.test.ts` — new case: attached-spec entries carry `path`/`title`, no
  `body`/`content` field)
- AC-7. IF a `reviewFocus` entry's `findingId` is not present in the finding set given to
  that same call, THEN the system shall drop that entry before it is persisted or returned.
  (traces: US-7, US-10) (verify: `service.test.ts` — new case: mocked LLM returns an unknown
  `findingId`; asserts it is absent from both the persisted row and the response)
- AC-8. The system shall exclude findings with a non-null `dismissedAt` from the candidate
  finding set used for `reviewFocus` grounding. (traces: US-2) (verify: `assemble-input.test.ts`
  — new case: a dismissed finding is absent from the assembled finding set)
- AC-9. The system shall cap `reviewFocus[]` at 8 entries, preserving the model's own
  ranking order (index 0 = read first) and dropping any entries beyond the cap. (traces:
  US-2) (verify: `service.test.ts` — new case: a mocked 12-entry model response is
  truncated to 8, in original order)
- AC-10. The system shall produce the synthesized brief via exactly one structured LLM call
  per compute or refresh — no follow-up calls, and no re-derivation of intent, blast radius,
  findings, or smart-diff within this feature's own code path. (traces: US-1, US-2, US-3,
  US-4) (verify: `service.test.ts` — asserts `container.llm.completeStructured` is invoked
  exactly once per job run)
- AC-11. The system shall use the same "latest review" finding-set definition already used
  by the Overview verdict card and the PR-list findings column for `reviewFocus` grounding
  — it shall not derive an independent definition of "latest review." (traces: US-2)
  (verify: `assemble-input.test.ts` — new case comparing the assembled finding set against
  `computeFindingsByPr`'s output for the same PR)
- AC-12. WHEN assembling the synthesis call's input, the system shall clip each included
  finding's `rationale` to a fixed per-finding character budget, so total prompt size stays
  bounded regardless of how many findings the PR has. (traces: US-7) (verify:
  `assemble-input.test.ts` — new case: a finding with an oversized rationale is clipped, not
  dropped)
- AC-13. The system shall wrap every PR-derived text field passed into the synthesis prompt
  (finding rationale/title/suggestion, intent goal/inScope/outOfScope/riskAreas labels,
  blast-derived symbol/caller names, attached-spec titles) as untrusted background content,
  with an explicit instruction never to follow directives embedded within it. (traces: US-7)
  (verify: inspect `server/src/prompts/brief-synth.system.md` for an untrusted-content
  clause equivalent to the Intent layer's; `rg -n "untrusted" server/src/prompts/
  brief-synth.system.md` returns a match)

**`riskLevel` floor**

- AC-14. IF the input finding set contains at least one finding with severity `'blocker'`
  or `'critical'`, THEN the system shall set `riskLevel` to at least `'high'`, overriding a
  lower model-assigned value. (traces: US-3) (verify: `service.test.ts` — new case: mocked
  model returns `riskLevel: 'low'` with a blocker finding present; asserts persisted/returned
  `riskLevel === 'high'`)
- AC-15. WHILE the input finding set contains no `blocker`/`critical` finding, the system
  shall preserve the model-assigned `riskLevel` unchanged (the floor is a lower bound only,
  never adjusts a value downward). (traces: US-3) (verify: `service.test.ts` — new case: no
  blocker/critical finding present; asserts persisted `riskLevel` equals the mocked model
  output verbatim)

**States**

- AC-16. IF no `pr_intent` row exists for the PR, THEN `GET .../overview/brief-synth` shall
  return `{status: 'not_ready', missing}` including `'intent'`, without enqueuing an intent
  computation. (traces: US-6) (verify: `server/test/overview-brief-synth.it.test.ts` — new
  case: PR with no intent row → `not_ready`, `missing` includes `'intent'`; no
  `overview.intent` job enqueued)
- AC-17. IF no review satisfying the definition in AC-11 exists for the PR, THEN `GET
  .../overview/brief-synth` shall return `{status: 'not_ready', missing}` including
  `'review'`. (traces: US-6) (verify: same file — new case: PR with intent but no review →
  `not_ready`, `missing` includes `'review'`)
- AC-18. WHEN both intent and a qualifying review are absent, the system shall return
  `missing` containing both `'intent'` and `'review'`. (traces: US-6) (verify: same file —
  new case asserting both entries present)
- AC-19. WHEN intent and a qualifying review both exist and no `pr_brief` row exists yet for
  the PR, `GET .../overview/brief-synth` shall enqueue a compute job and return
  `{status: 'computing', runId}`. (traces: US-1, US-5) (verify: same file — cold GET →
  `computing`; draining the job queue then re-querying returns `ready`)
- AC-20. WHEN a cached `pr_brief` row's `basedOn` (`headSha`, `reviewId`,
  `intentComputedAt`) all match the PR's current values, `GET .../overview/brief-synth`
  shall return `{status: 'ready', data}` and enqueue nothing. (traces: US-1) (verify: same
  file — warm GET after a successful compute returns `ready` with no new job enqueued)
- AC-21. WHEN the PR's current `head_sha` differs from the cached `basedOn.headSha`, `GET
  .../overview/brief-synth` shall return `{status: 'ready-stale', data, staleReasons}`
  including `'head_sha'`. (traces: US-5) (verify: same file — mutate `head_sha` after a
  compute; re-GET returns `ready-stale` with `staleReasons: ['head_sha']`)
- AC-22. WHEN a review more recent than the cached `basedOn.reviewId` has completed, `GET
  .../overview/brief-synth` shall return `ready-stale` with `staleReasons` including
  `'new_review'`. (traces: US-5) (verify: same file — insert a newer review row after a
  compute; re-GET returns `ready-stale` including `'new_review'`)
- AC-23. WHEN `pr_intent.computedAt` is later than the cached `basedOn.intentComputedAt`,
  `GET .../overview/brief-synth` shall return `ready-stale` with `staleReasons` including
  `'intent'`. (traces: US-5) (verify: same file — recompute intent after a brief-synth
  compute; re-GET returns `ready-stale` including `'intent'`)
- AC-24. The system shall list every applicable stale reason in `staleReasons`,
  deduplicated, rather than only the first one detected. (traces: US-5) (verify: same file —
  new case mutating both `head_sha` and inserting a new review; asserts `staleReasons`
  contains both, each exactly once)
- AC-25. WHILE a cached row is `ready-stale`, the system shall keep serving the cached data
  and shall not auto-enqueue a recompute; only an explicit refresh recomputes. (traces:
  US-5, US-6) (verify: same file — repeated GETs on a stale row return the same
  `computedAt` and enqueue no job)

**Endpoints & rate limits**

- AC-26. The system shall expose `GET /pulls/:id/overview/brief-synth` returning a
  `PrWhyRiskBriefResponse` in exactly one of the five states above. (traces: US-1, US-5,
  US-6) (verify: same integration file, full state-matrix coverage)
- AC-27. WHEN `POST /pulls/:id/overview/brief-synth/refresh` is called with intent and a
  qualifying review present, the system shall enqueue a recompute unconditionally
  (ignoring current freshness) and respond `202` with `{runId}`. (traces: US-5) (verify:
  same file — refresh on an already-`ready` PR still enqueues a new job)
- AC-28. IF refresh is called while intent or a qualifying review is missing, THEN the
  system shall reject the request with a 4xx error and shall not enqueue a job or write a
  partial `pr_brief` row. (traces: US-6) (verify: same file — refresh on a PR with no
  intent row → 4xx, no job enqueued, `pr_brief` table unchanged)
- AC-29. IF refresh is called again for the same PR within 60 seconds of the prior refresh,
  THEN the system shall reject with a rate-limit error (429) carrying a retry-after value.
  (traces: US-8) (verify: same file — two refreshes within 60s → second returns 429 with
  `retryAfterSeconds`)
- AC-30. IF a workspace's brief-synth computations (cold computes plus refreshes combined)
  exceed 30 within a rolling hour, THEN further computes shall be rejected with a 429 until
  the window rolls. (traces: US-8) (verify: same file — 31st compute/refresh in the window
  returns 429)
- AC-31. The system shall track brief-synth's rate-limit counters independently of the
  Intent layer's counters — consuming one feature's budget never reduces the other's.
  (traces: US-8) (verify: same file — exhausting brief-synth's workspace budget still
  allows an Intent compute/refresh to succeed, and vice versa)
- AC-32. The system shall expose `GET /pulls/:id/overview/brief-synth/stream?runId=…`
  streaming the run's `RunEvent` progress (`info`/`done`/`error`) over SSE, using the same
  bridging pattern as the Intent stream endpoint. (traces: US-1, US-5) (verify:
  `server/test/overview-brief-synth.it.test.ts` — SSE stream emits `info` then `done` for a
  compute run)
- AC-33. WHEN a compute or refresh job finishes writing its `pr_brief` row, THEN (and only
  then) the system shall publish the `'done'` SSE event for that run. (traces: US-1, US-5)
  (verify: same file — asserts the DB row is present at the moment `'done'` is observed on
  the stream, never before)

**Cost tracking & model resolution**

- AC-34. WHEN a compute or refresh job finishes (success or failure), the system shall
  persist an `agent_runs` row (workspace, PR, model, tokensIn, tokensOut, status) so the
  synthesis call is visible in the PR's existing run/cost history, consistent with how
  reviews are tracked. (traces: US-4) (verify: same file — after a compute, `GET
  /pulls/:id/runs` includes a new row attributable to this feature)
- AC-35. The system shall resolve the synthesis call's provider/model via the existing
  `risk_brief` feature-model id, honoring any workspace override the same way other
  per-feature model choices do. (traces: US-4) (verify: `rg -n "resolveFeatureModel\(.*'risk_brief'"
  server/src/modules/overview/brief-synth/` returns a match; `service.test.ts` — a
  workspace override for `risk_brief` changes which mocked provider/model is invoked)
- AC-36. The system shall persist `cost {tokensIn, tokensOut, usd}` reflecting only the most
  recent synthesis call, not a cumulative total across refreshes. (traces: US-4) (verify:
  same file — two refreshes with different mocked token counts leave the second value
  persisted, not a sum)

**Persistence**

- AC-37. The system shall extend the existing `pr_brief` table (already present, keyed by
  `pr_id`) with the new columns needed for `basedOn`, `riskLevel`, `model`, cost, and
  `computedAt`, via an additive migration — never a `CREATE TABLE pr_brief` that would
  collide with the existing relation. (traces: US-9) (verify: `server/src/db/migrations/`
  — new migration file contains `ALTER TABLE "pr_brief"`, not `CREATE TABLE`; `pnpm
  db:migrate` succeeds against a database that already has the pre-existing `pr_brief`
  table)
- AC-38. WHEN a refresh writes the `pr_brief` row, the system shall overwrite every
  persisted column explicitly — no column is silently left holding a prior value on
  conflict. (traces: US-9) (verify: `server/src/modules/overview/brief-synth/
  repository.test.ts` — new case: a second upsert with different values leaves no stale
  column from the first)

**Retirement**

- AC-39. The system shall remove the dormant `PrBrief` composite export from both
  `server/src/vendor/shared/contracts/brief.ts` and its client mirror, without modifying
  the still-used building-block schemas in the same file (`Intent`, `BlastRadius`, `Risk`/
  `Risks`, `PrHistory`, and `SmartDiff` — `SmartDiff` in particular has live consumers in
  `server/src/modules/pulls/smart-diff/`). (traces: US-9) (verify: `rg -n "export const
  PrBrief" server/src/vendor/shared/contracts/brief.ts client/src/vendor/shared/contracts/
  brief.ts` returns no matches; `pnpm typecheck` passes in both packages; `server/src/
  modules/pulls/smart-diff/service.test.ts` still passes unchanged)

**Client rendering**

- AC-40. The client shall render a visually distinct state for each of `not_ready`,
  `computing`, `ready`, `ready-stale`, and `error`, matching the existing `IntentCard`
  state-per-status convention. (traces: US-1, US-6) (verify:
  `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/
  WhyRiskBriefCard/WhyRiskBriefCard.test.tsx` — new file, one test per state)
- AC-41. WHEN status is `not_ready`, the client shall display a message naming which
  input(s) are missing (intent, review, or both) rather than a generic empty state.
  (traces: US-6) (verify: same test file — `not_ready` with `missing: ['review']` renders
  text naming "review"; `missing: ['intent','review']` names both)
- AC-42. WHILE status is `not_ready`, the client shall disable or hide the manual refresh
  control, since refreshing cannot succeed until the missing input(s) exist. (traces: US-6)
  (verify: same test file — `not_ready` state renders no enabled Refresh button)
- AC-43. WHEN a "Review focus" item is clicked, the client shall navigate to that finding's
  file:line, resolved from the findings data the client already holds for the PR (via the
  existing per-PR reviews/findings query) — no new endpoint is introduced for this
  resolution. (traces: US-2) (verify: same test file — clicking an item with a known
  `findingId` triggers navigation to that finding's `file:line`, matching the pattern
  already asserted for `FindingsCell`)
- AC-44. The client shall render the "Review focus" list as a real ordered/numbered list
  with keyboard-navigable links, each item showing its rank, `file:line`, and the one-line
  `note`. (traces: US-2) (verify: same test file — asserts `role="list"`/ordered semantics
  and that each item is reachable via keyboard `Tab`)
- AC-45. WHEN a refresh call returns a rate-limit error, the client shall surface a
  distinguishable message telling the user to retry shortly, mirroring the Intent layer's
  refresh-429 handling (captured `ApiError`, not a generic failure toast). (traces: US-5,
  US-8) (verify: same test file — a mocked 429 response renders a "try again" message, not
  a generic error state)

## Edge cases

- **Clean PR, zero findings.** `reviewFocus[]` is an empty array; `what`/`why`/`riskLevel`
  are still computed from intent/blast/smart-diff alone. Not an error state.
- **All findings dismissed.** Per AC-8, the candidate set is empty even though `findings`
  rows exist — `reviewFocus[]` is legitimately empty; this is distinct from "no findings at
  all" only in the underlying data, not in the response shape.
- **No attached context documents.** The agent's `attachedContextPaths` is empty or unset —
  the synthesis call proceeds with intent/blast/findings/diff-stats only (per Non-goals, no
  semantic retrieval is substituted in).
- **Multiple reviews for one PR (multi-agent).** `reviewFocus` grounding pools findings using
  the same latest-review definition as the verdict card (AC-11), so multi-agent semantics
  are inherited, not reinvented. `basedOn.reviewId` anchors on the most recently created
  review row at compute time, for `new_review` staleness comparison only — findings pooled
  for grounding are not necessarily limited to that single review.
- **Concurrent refresh from two tabs / the freshness-keyed-GET race.** Identical shape to
  the documented Intent-layer race (client-INSIGHTS 2026-07-04): an in-flight refresh does
  not change `basedOn` until the job commits, so a GET immediately after a refresh POST can
  still return the pre-refresh `ready`/`ready-stale` row. The client MUST bridge the
  POST-returned `runId` into its own SSE subscription (mirroring `useOverviewIntent`) rather
  than relying on query invalidation alone.
- **Refresh attempted while `not_ready`.** Rejected outright (AC-28) — never silently
  enqueues a job that can only fail once the handler discovers the same missing input.
- **Very large finding count.** Every non-dismissed finding is still included as input
  (AC-11 governs *which* findings, not how many); per-finding size is bounded (AC-12), not
  the count — this keeps grounding complete while bounding total prompt size.
- **Unknown `findingId` from the model.** Dropped defensively before persistence (AC-7) —
  this is expected occasional model noise, not a hard failure of the whole compute.

## Non-functional

- **Security.** No diff bodies and no attached-document bodies ever reach this call (AC-5,
  AC-6). This call introduces **no new outbound network requests** — unlike the Intent
  layer's P3 URL fetcher, every input here is already-computed internal data (intent, blast
  radius via the existing facade, findings, smart-diff, locally-read attached-spec
  paths/titles) — so no new SSRF surface is introduced. `platform/grounding.ts`'s citation
  gate is **not** invoked by this call: because the model only ever selects finding ids from
  a provided set (AC-2, AC-7), there is no free-text file:line output for that gate to
  police. This is a property of the design, not a gap — do not wire the citation gate onto
  this call, and do not treat its absence here as a regression.
- **Cost & DoS.** Rate limits mirror the Intent layer's numeric values (30 computes/hour/
  workspace, 1 refresh/minute/PR — AC-29, AC-30) but are tracked independently (AC-31). One
  structured call per compute/refresh (AC-10) bounds cost per invocation.
- **Performance.** No formal SLA is set by the design doc. Because this call has no external
  fetches (unlike Intent's reference collection), a reasonable target is `computing → ready`
  within ~15 seconds for a typical PR — looser than Intent's ~10s target only because the
  input assembly (intent + blast facade + findings + smart-diff) is somewhat heavier to
  gather even though nothing is fetched over the network. This is a soft target, not a hard
  requirement, and may be revisited once real latency is measured.
- **Observability.** Every compute/refresh — success or failure — leaves an `agent_runs`
  row (AC-34), so cost/token history for this feature is auditable the same way review runs
  already are.
- **Accessibility.** The "Review focus" list is a real ordered list with keyboard-navigable
  links (AC-44), not a div soup of clickable spans.
- **Internationalization.** All new user-facing strings (the `not_ready` message, the
  "Review focus" heading, stale-reason banner text) go through the existing `next-intl` message
  catalog — the pattern already used in Settings and `VerdictBanner`. NOTE (corrected against
  code 2026-07-13): the sibling Overview cards this feature visually matches (`IntentCard`,
  `PrBriefCard`) are **not** i18n'd today — they use hardcoded English literals. This feature
  adopts i18n regardless; retrofitting the two sibling cards for consistency is out of scope
  (tracked as a follow-up, see plan Risk 3).

## Interfaces & flows

**Data shapes**

| Name | Shape | Notes |
|---|---|---|
| `PrWhyRiskBrief` (new, `shared/contracts/brief-synth.ts`) | `{ what: string, why: string, riskLevel: RiskSeverity, risks: RiskArea[], reviewFocus: ReviewFocusItem[], model: string, cost: {tokensIn: number, tokensOut: number, usd: number}, computedAt: string, basedOn: {headSha: string, reviewId: string, intentComputedAt: string} }` | Reuses the existing `RiskSeverity` enum from `contracts/brief.ts` — does not redefine it (AC-1). |
| `RiskArea` (new, extends `intent.riskAreas` shape) | `{ icon: RiskAreaIcon, label: string, fileRef?: {file: string, line: number} }` | `icon`/`label` values equal `intent.riskAreas[]` verbatim (AC-3); `fileRef` is the only server-attached addition (AC-4). |
| `ReviewFocusItem` (new) | `{ findingId: string, note: string }` | `findingId` references `findings.id`; no file/line/title on the wire (AC-2) — client resolves those (AC-43). |
| `PrWhyRiskBriefResponse` (new, discriminated by `status`) | `{status:'ready', data}` \| `{status:'ready-stale', data, staleReasons}` \| `{status:'not_ready', missing}` \| `{status:'computing', runId}` \| `{status:'error', message}` | `staleReasons: ('head_sha'\|'new_review'\|'intent')[]`; `missing: ('intent'\|'review')[]` — `not_ready` has no equivalent in `PrIntentResponse` today; it is net-new to this contract (AC-16..18). |

**Endpoints in scope**

| Endpoint | Purpose | Key behavior |
|---|---|---|
| `GET /pulls/:id/overview/brief-synth` | Read-through cache lookup | AC-16..AC-26 |
| `POST /pulls/:id/overview/brief-synth/refresh` | Force recompute (rate-limited) | AC-27..AC-31, 202 + `{runId}` |
| `GET /pulls/:id/overview/brief-synth/stream?runId=…` | SSE progress for a compute/refresh run | AC-32, AC-33 |

**State machine**

| State | Meaning | Entered when |
|---|---|---|
| `not_ready` | Cannot compute yet | Intent and/or a qualifying review is missing (AC-16..18) — no cascade recompute of either |
| `computing` | Job in flight | Cache miss on first view, or an explicit refresh (AC-19, AC-27) |
| `ready` | Cache hit, fresh | Cached `basedOn` matches the PR's current `headSha`/latest review/intent `computedAt` (AC-20) |
| `ready-stale` | Cache hit, drifted | Any of `head_sha` / `new_review` / `intent` changed since the cached compute (AC-21..24) |
| `error` | Job failed | LLM or validation failure surfaced via SSE `'error'` and the next `GET` |

**Compute flow**

```mermaid
sequenceDiagram
  participant UI as Client (WhyRiskBriefCard)
  participant API as Server (overview/brief-synth service)
  participant DB as Postgres (pr_intent, reviews, findings, pr_brief)
  participant RI as RepoIntel facade (getBlastRadius)
  participant CTX as ContextService (attached paths/titles)
  participant LLM as LLM provider (risk_brief feature-model)
  participant Bus as runBus (SSE)

  UI->>API: GET .../brief-synth (or POST .../refresh)
  API->>DB: load PR, pr_intent row, latest review + findings (AC-11 definition)
  alt intent or qualifying review missing
    API-->>UI: { status: 'not_ready', missing }
  else both present
    API->>DB: load pr_brief row, compare basedOn to current state
    alt cached row fresh
      API-->>UI: { status: 'ready'/'ready-stale', data, ... }
    else cache miss or explicit refresh
      API->>API: enqueue job, return { status: 'computing', runId }
      API->>RI: getBlastRadius(repoId, changedFiles) — new call site, existing method
      API->>CTX: listPaths/list — attached paths + titles only, no bodies
      API->>API: assembleBriefInput() — intent + blast summary + findings (clipped) + diff stats + attached specs; NO diff bodies (AC-5, AC-6, AC-12, AC-13)
      API->>LLM: one structured call (model resolved via 'risk_brief', AC-35)
      LLM-->>API: { what, why, riskLevel, risks, reviewFocus }
      API->>API: drop unknown findingIds (AC-7); floor riskLevel (AC-14, AC-15); cap reviewFocus (AC-9)
      API->>DB: upsert pr_brief (all columns, AC-38) + insert agent_runs row (AC-34)
      API->>Bus: publish 'done' only after the DB write commits (AC-33)
      Bus-->>UI: SSE 'done' → invalidate query → GET returns 'ready'
    end
  end
```

**Migration (`pr_brief`, extend — do not recreate)**

| Column (new) | Type | Purpose |
|---|---|---|
| `head_sha` | `text not null` | `basedOn.headSha` — freshness comparison (AC-21) |
| `review_id` | `uuid`, FK → `reviews.id`, `on delete set null` | `basedOn.reviewId` — anchor for `new_review` staleness (AC-22) |
| `intent_computed_at` | `timestamptz not null` | `basedOn.intentComputedAt` — `intent` staleness (AC-23) |
| `risk_level` | `text not null` | Persisted, already-floored `riskLevel` (AC-14) |
| `model` | `text` | Resolved model id used for this compute (AC-35) |
| `prompt_tokens`, `completion_tokens` | `integer not null default 0` | `cost.tokensIn`/`cost.tokensOut` (AC-36) |
| `cost_usd` | `numeric(10,6) not null default 0` | `cost.usd` (AC-36) |
| `computed_at` | `timestamptz not null default now()` | `PrWhyRiskBrief.computedAt` |
| `json` (existing column, repurposed) | `jsonb not null` | `what`/`why`/`risks`/`reviewFocus` — the fields not promoted to first-class columns |

The migration is additive (`ALTER TABLE "pr_brief" ADD COLUMN ...`), mirroring
`0015_pr_intent_overview.sql`'s treatment of `pr_intent` — the pre-existing `{prId, json}`
shape and its FK to `pull_requests` are preserved (AC-37).

**Client hook contract (new, cloned from `useOverviewIntent`)**

| Field | Shape | Notes |
|---|---|---|
| `status` | `'idle' \| 'loading' \| 'not_ready' \| 'computing' \| 'ready' \| 'ready-stale' \| 'error'` | `not_ready` and its `missing` payload are net-new relative to `UseOverviewIntent` (AC-40, AC-41). |
| `data` | `PrWhyRiskBrief \| null` | Present for `ready`/`ready-stale` only. |
| `missing` | `('intent'\|'review')[] \| null` | Present for `not_ready` only (AC-41). |
| `staleReasons` | `('head_sha'\|'new_review'\|'intent')[] \| null` | Present for `ready-stale` only (AC-24). |
| `refresh` | `() => Promise<void>` | Disabled/no-op while `not_ready` (AC-42); surfaces 429 distinguishably (AC-45). |

## Inputs (provenance)

- `[reused: pr_intent row]` intent (`goal`/`inScope`/`outOfScope`/`riskAreas`) — read, not
  recomputed (AC-3, AC-16).
- `[reused: existing capability, new call site]` blast summary — via `RepoIntel.
  getBlastRadius(repoId, changedFiles)`. This is a real, working method with zero prior
  Overview-module callers (see Problem & why, correction 3) — reused as-is, no new
  algorithm, but genuinely new wiring for this module.
- `[reused: findings rows]` findings for the latest review (id, file, startLine, endLine,
  severity, category, title, rationale) — via the same latest-review definition already
  used elsewhere (AC-11), non-dismissed only (AC-8).
- `[reused: L03 SmartDiff]` diff stats (core/wiring/boilerplate counts, +/−) — read from the
  already-computed grouping, not re-derived.
- `[reused: intent.references]` linked issue — already embedded in the cached intent row;
  no separate fetch.
- `[reused: ContextService]` attached specs — paths/titles only, via the reviewing agent's
  `attachedContextPaths`, the same primitive `run-executor.ts` already uses (AC-6).
- `[new call: 1 structured LLM call per compute/refresh]` the synthesized brief itself
  (`what`, `why`, `riskLevel`, `risks[]` fileRefs where matched, `reviewFocus[]`) — AC-10.
- `[deterministic: no LLM]` `riskLevel` floor (AC-14, AC-15), `findingId` validation (AC-7),
  `reviewFocus` cap/ordering (AC-9), `fileRef` matching (AC-4) — all server-side, zero
  additional model calls.
- `[deterministic: existing PriceBook/agent_runs pattern]` cost persistence (AC-34, AC-36) —
  no new "run_cost" table; uses the existing `agent_runs` observability path (see Problem &
  why, correction 2).

## Untrusted inputs

Every field in **Inputs (provenance)** above that ultimately derives from PR-author-supplied
or repo-content-derived text is untrusted third-party content and must be treated as data to
synthesize, never as instructions:

- Finding `rationale`/`title`/`suggestion` text (LLM-authored from a prior review pass, but
  itself derived from untrusted diff/PR content).
- Intent's `goal`/`inScope`/`outOfScope`/`riskAreas[].label` text.
- Blast-derived symbol and caller names (`changed_symbols`, `callers`) — sourced from
  identifiers in the repo's own code, which a malicious PR could craft adversarially.
- Attached-spec **titles** (not bodies) — sourced from filenames/headings in the repo clone.

AC-13 requires the synthesis system prompt to wrap all of the above as untrusted background
content with an explicit no-instructions-follow clause, the same discipline the Intent
layer's system prompt already establishes for its own inputs (design doc's UNTRUSTED CONTENT
CLAUSE, §8.5 of the Intent layer design). This is a **separate** system prompt from Intent's
(a new call, a new prompt file) — it must carry its own clause, not silently inherit
Intent's by virtue of consuming Intent's output.

## Traceability

| AC-id | US-id | module | task-id |
|---|---|---|---|
| AC-1 | US-1, US-3, US-4 | server, client | — |
| AC-2 | US-2, US-7, US-10 | server, client | — |
| AC-3 | US-3 | server | — |
| AC-4 | US-3, US-7 | server | — |
| AC-5 | US-7 | server | — |
| AC-6 | US-7 | server | — |
| AC-7 | US-7, US-10 | server | — |
| AC-8 | US-2 | server | — |
| AC-9 | US-2 | server | — |
| AC-10 | US-1, US-2, US-3, US-4 | server | — |
| AC-11 | US-2 | server | — |
| AC-12 | US-7 | server | — |
| AC-13 | US-7 | server | — |
| AC-14 | US-3 | server | — |
| AC-15 | US-3 | server | — |
| AC-16 | US-6 | server | — |
| AC-17 | US-6 | server | — |
| AC-18 | US-6 | server | — |
| AC-19 | US-1, US-5 | server | — |
| AC-20 | US-1 | server | — |
| AC-21 | US-5 | server | — |
| AC-22 | US-5 | server | — |
| AC-23 | US-5 | server | — |
| AC-24 | US-5 | server | — |
| AC-25 | US-5, US-6 | server | — |
| AC-26 | US-1, US-5, US-6 | server | — |
| AC-27 | US-5 | server | — |
| AC-28 | US-6 | server | — |
| AC-29 | US-8 | server | — |
| AC-30 | US-8 | server | — |
| AC-31 | US-8 | server | — |
| AC-32 | US-1, US-5 | server | — |
| AC-33 | US-1, US-5 | server | — |
| AC-34 | US-4 | server | — |
| AC-35 | US-4 | server | — |
| AC-36 | US-4 | server | — |
| AC-37 | US-9 | server | — |
| AC-38 | US-9 | server | — |
| AC-39 | US-9 | server, client | — |
| AC-40 | US-1, US-6 | client | — |
| AC-41 | US-6 | client | — |
| AC-42 | US-6 | client | — |
| AC-43 | US-2 | client | — |
| AC-44 | US-2 | client | — |
| AC-45 | US-5, US-8 | client | — |

## Open questions

All four open points the design doc raised for `spec-creator`, plus three additional
discrepancies found during this spec's design-analysis pass, are resolved below
(coordinator-default-confirmed per the dispatch's stated defaults, plus direct verification
against the current codebase). No unresolved ambiguity remains; recorded here for
traceability.

1. **Rate-limit numbers — resolved.** Reuse the Intent layer's exact values: 30 computes/
   refreshes per hour per workspace, 1 refresh per minute per PR (AC-29, AC-30) — but
   tracked in independent counters (AC-31), per the dispatch's stated default.
2. **`risks[]` provenance — resolved.** `risks[]` reuses `intent.riskAreas` verbatim (no
   re-derivation by the synthesis call) and each entry may carry a server-attached, grounded
   `fileRef` sourced from findings/blast — never fabricated (AC-3, AC-4), per the dispatch's
   stated leaning.
3. **`pr_brief` migration column set — resolved.** See AC-37 and the Interfaces & flows
   migration table: `basedOn` fields (`head_sha`, `review_id`, `intent_computed_at`) become
   first-class columns for cheap staleness comparison; the remaining brief content
   (`what`/`why`/`risks`/`reviewFocus`) stays in the existing `json` column. Additionally
   (found during this spec's own analysis, not anticipated by the design doc): the migration
   must be an `ALTER TABLE` against the **already-existing** `pr_brief` relation, not a
   `CREATE TABLE` — see Problem & why, correction 1.
4. **`Feature-Models` id — resolved by direct verification.** `risk_brief` already exists in
   `server/src/vendor/shared/contracts/platform.ts`'s `FEATURE_MODELS` registry (label "Risk
   Brief", default `anthropic/claude-sonnet-5`) with zero current consumers — confirmed by
   `rg`, not assumed. This feature is its first consumer (AC-35). No new id is introduced.
5. **(Found during design-analysis, not a design-doc open question) "Blast radius is
   shipped" — corrected, not blocking.** See Problem & why, correction 3: there is no
   existing Overview-tab card or route for blast radius; this feature calls the existing
   `RepoIntel.getBlastRadius` facade method directly as a new call site. Resolved as
   `[reused: existing capability, new call site]` in Inputs (provenance) — no user decision
   needed, this is a factual correction to the design doc's framing.
6. **(Found during design-analysis) "Records a `run_cost` row" — corrected, not blocking.**
   No `run_cost` table exists in the schema. Restated precisely as: persist an `agent_runs`
   row (AC-34); the brief's own `cost` field is populated from that call's token/price data,
   mirroring `pr_intent`'s persisted-cost pattern rather than `PrOverviewBrief`'s
   read-time-`PriceBook`-estimate pattern. See Problem & why, correction 2.

## Self-check

- **Placeholder scan** — pass. No `TBD`/`TODO`/`<fill in>` remains; every open point above
  is a resolved decision with a pointer to the AC(s)/section that captures it.
- **EARS-testability** — pass. Every AC-1..AC-45 matches exactly one of the five patterns
  (ubiquitous / event-driven / state-driven / unwanted-behavior / optional-feature) with a
  single trigger and a single testable response. Compound criteria were split during
  drafting (e.g. "missing both intent and review" is its own AC-18, separate from AC-16/
  AC-17's single-missing-input cases; "floor raises" (AC-14) and "floor never lowers"
  (AC-15) are two ACs, not one compound criterion).
- **Traceability** — pass. Every AC carries `(traces: US-x)`; every US-1..US-10 is covered
  by at least one AC (checked both directions); the Traceability table is complete and uses
  only the header's declared module names (`server`, `client`).
- **Verification** — pass. Every AC has a concrete `(verify: …)` hint naming a specific
  (mostly new, not-yet-existing) test file and case, or an `rg` inspection command — none
  say "manual testing" or "QA will check."
- **Consistency** — pass. The header's `Modules: server, client` matches every module
  referenced in Interfaces & flows and the Traceability table; no `reviewer-core`/`mcp`/`e2e`
  change is implied anywhere (confirmed: `platform/grounding.ts` is explicitly untouched,
  per Non-functional).
- **Scope** — pass. Goals/Non-goals are both populated; every AC traces back to a Goal
  (no AC introduces a new Blast Radius UI panel, a new review pass, or auto-cascade
  recompute — all explicitly excluded by Non-goals).
- **Ambiguity** — pass. No vague verbs ("work fine," "handle gracefully," "as needed")
  remain; every criterion names a concrete trigger and a concrete, testable response.
- **Untrusted inputs** — pass. Section names every PR-derived input field and the boundary
  (the new synthesis system prompt) where each is consumed, plus the specific AC (AC-13)
  requiring the wrapping.
- **No implementation detail** — pass. Interfaces & flows contains schemas, an endpoint
  table, a state table, a sequence diagram, and a migration column table — no function
  bodies, no code snippets, no pseudocode. Concrete file paths in `(verify: …)` hints name
  where a test should live, which is a verification instruction, not implementation
  guidance for the feature itself.
- **Open questions are explicit** — pass. All resolved points are recorded in `## Open
  questions` with their resolution and rationale, including three discrepancies this spec
  found beyond the design doc's own four — none were silently decided without a written
  trail.
