# PR Overview tab — design

**Status:** design approved (Sections 1–2 explicitly, 3+ via "skip and write the spec").
**Date:** 2026-06-24
**Branch target:** a new feature branch off `l02` (current working branch).

## 1. Goal

Replace the near-empty Overview tab on `/repos/:repoId/pulls/:number` with a rich, three-block view modelled on the reference screenshot:

1. **PR Brief** — composite verdict + summary, findings/blockers count, PR score, token cost
2. **Intent** — restated PR goal, in-scope / out-of-scope bullets, risk-area chips
3. **Blast Radius** — counts (symbols / callers / endpoints / crons) + a tree of impacted code + collapsed "Prior PRs touching these files"

Each block fetches independently. First open computes-and-caches. Subsequent opens are instant. Per-block manual "Refresh" affordance. No change to other tabs.

## 2. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | Full vertical: real backend + UI, not a mock | User chose A |
| Q2 | Lazy compute on first open + cache | User chose B; matches local-first cost model |
| Q3 | Hybrid Blast Radius: static skeleton + LLM classification | User chose C — but see §5: the static half already exists in `repo-intel`, so the "hybrid" reduces to "use repo-intel + optional LLM polish pass v2" |
| Q4 | Per-block freshness keys + manual refresh | User chose B |
| Q5 | New `overview` module; LLM via existing `platform/` (container, structured, model-router) | User chose C; platform layer already shared, no refactor needed |
| Granularity | Three independent endpoints / cache rows | Pre-decided; cost profiles differ by 100× |

## 3. What already exists (and what we reuse)

Discovered during design exploration — these shortcut large chunks of the originally-planned work:

- **`repo-intel.getBlastRadius(repoId, files): BlastResult`** at `server/src/modules/repo-intel/service.ts:220`. Returns `{ changedSymbols, callers, impactedEndpoints, factsByFile }` with endpoints+crons per file. **The entire static-analysis pipeline is done.** No new ripgrep / AST work is required.
- **`pr_intent`** table (`server/src/db/schema/reviews.ts:48`) — exists but lean: `{ prId, intent, inScope, outOfScope }`. Needs schema extension (risk areas, freshness keys, cost tracking). Not currently populated by any module.
- **`pr_brief`** table — exists as `{ prId, json }` but unused. **We do not cache Brief**: aggregation is a single indexed query over `reviews` + `findings` and a refresh is cheaper than the cache-invalidation logic. The table can stay (it's empty, no harm) or be dropped in a follow-up; out of scope here.
- **`pr_files`** + **`pull_requests`** — file paths per PR are already stored → Prior PRs is a SQL query, not a new table.
- **`platform/structured.ts`**, **`platform/model-router.ts`**, **`platform/container.ts`** — shared LLM plumbing already in place. New module consumes them.

What we still build: a new `overview` module that orchestrates these pieces, schema migrations for the freshness columns, the Intent LLM extractor, the four endpoints, and the React UI.

## 4. Architecture

```
client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/
  OverviewTab.tsx                 composes Brief + Intent + BlastRadius + PriorPrs
  styles.ts
  _components/
    PrBriefCard/                  verdict pill, summary, score donut, cost line
    IntentCard/                   goal line, two-column scope, risk chips
    BlastRadiusCard/              counts row, symbol tree, endpoint/cron chips, Tree↔Graph toggle (Graph = v2)
    PriorPrsCard/                 collapsed list with count badge
    SectionFooter/                "Computed Xs ago · Refresh" — shared

client/src/lib/hooks/overview.ts  useOverviewBrief / useOverviewIntent / useOverviewBlastRadius / useOverviewPriorPrs
                                  + useRefreshOverview(prId, block)

server/src/modules/overview/
  routes.ts                       see §6
  service.ts                      orchestrator: freshness → recompute → return
  repository.ts                   drizzle queries
  brief/
    aggregate.ts                  pure: runs+findings → PrBriefJson
  intent/
    extract.ts                    one structured LLM call via platform/structured
    prompt.md                     symlinked from docs/agent-prompts/intent-extractor.md
  blast-radius/
    project.ts                    repo-intel BlastResult → API shape (folds factsByFile into per-symbol nodes)
  prior-prs/
    query.ts                      drizzle: pr_files JOIN pull_requests, dedup, recency-rank

server/src/db/schema/reviews.ts   extend pr_intent (no rename; add columns)
server/src/db/schema/overview.ts  (only if we need a separate table for blast-radius cache — see §5.3; current call says no)
server/src/db/migrations/0xxx_pr_overview.sql

docs/agent-prompts/intent-extractor.md
@devdigest/shared                 add PrBriefJson, PrIntentDto, PrBlastRadiusDto, PrPriorPrsDto
```

Onion boundary: `overview/service.ts` is the only place that crosses modules — it reads from `reviews/repository`, calls `container.repoIntel.getBlastRadius`, calls `container.llm(...)` via `platform/structured`. No adapter is created or instantiated inside the module; all come via the container.

## 5. Per-block specs

### 5.1 PR Brief

**Source:** existing `reviews` + `findings` rows for this PR. No LLM. No cache (see §3 — pure aggregation per request).

**Shape (`PrBriefJson` in `@devdigest/shared`):**

```ts
type PrBriefJson = {
  verdict: 'approve' | 'request_changes' | 'comment' | 'no_runs';
  summary: string;          // 1–2 sentences, taken from the worst-verdict review
  findingsCount: number;    // total findings across runs
  blockersCount: number;    // findings with severity in (blocker, critical)
  score: number | null;     // 0–100 composite (mean of run.score, or null if no runs)
  totalCost: {              // sum across runs that produced reviews
    tokensIn: number;
    tokensOut: number;
    usd: number;
  };
  computedAt: string;       // ISO
  basedOnRunIds: string[];  // for cache invalidation when a new run lands
};
```

**Aggregation rules:**

- Verdict = worst across runs (`request_changes` > `comment` > `approve`). If no runs: `no_runs`.
- Summary = `reviews.summary` of the run that owns the worst verdict; tie-break by recency.
- Score = round(mean(reviews.score where not null)).
- `blockersCount` = `findings.severity in ('blocker','critical')`.

**Freshness:** N/A (no cache). Every read aggregates fresh. The response includes `basedOnRunIds` so a client can `if-none-match` if we later add caching.

**Endpoint:** `GET /api/pulls/:prId/overview/brief` → `{ status: 'ready', data: PrBriefJson } | { status: 'no_runs' }`. Always synchronous.

### 5.2 Intent

**Source:** one LLM call per (head_sha, body_hash).

**Schema extension (`pr_intent`):**

```sql
ALTER TABLE pr_intent
  ADD COLUMN head_sha          text NOT NULL,
  ADD COLUMN body_hash         text NOT NULL,
  ADD COLUMN risk_areas        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN model             text,
  ADD COLUMN prompt_tokens     integer NOT NULL DEFAULT 0,
  ADD COLUMN completion_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cost_usd          numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN computed_at       timestamptz NOT NULL DEFAULT now();
```

(The existing `pr_intent` table has zero population in code today — the `NOT NULL` columns without defaults are safe.)

**DTO:**

```ts
type PrIntentDto = {
  goal: string;                                      // mirrors db.intent
  inScope: string[];
  outOfScope: string[];
  riskAreas: { icon: 'shield'|'package'|'zap'|'database'|'globe'; label: string }[];
  model: string;
  cost: { tokensIn: number; tokensOut: number; usd: number };
  computedAt: string;
};
```

**LLM call:**

- Provider/model selected by `platform/model-router` from settings (same as reviews).
- Inputs: PR title, body, list of changed files (paths only), summary of diff stats (additions/deletions per file).
- Structured output via `platform/structured` with a Zod schema mirroring the DTO.
- Prompt lives at `docs/agent-prompts/intent-extractor.md`. The prompt instructs: restate the goal in one sentence, split scope into bullets, emit 1–3 risk chips chosen from a closed icon set.

**Freshness:** key = `(head_sha, body_hash)`. `body_hash = sha256(pr.body ?? '')`. On mismatch: enqueue recompute (job via `platform/jobs`), return `{ status: 'computing', runId }`. Client subscribes to SSE on `/api/pulls/:prId/overview/intent/stream`.

**Endpoint:** `GET /api/pulls/:prId/overview/intent` → `{ status: 'ready', data: PrIntentDto } | { status: 'computing', runId } | { status: 'error', message }`.

### 5.3 Blast Radius

**Source:** `container.repoIntel.getBlastRadius(repoId, changedFiles)`. Already implemented.

**Caching decision:** **do not cache.** `getBlastRadius` reads from precomputed `file_edges` / `symbols` / `references` / `file_facts` tables — it's a multi-join query, not a recomputation. Caching its result is double-buffering. Skip the `pr_blast_radius` table from the original draft.

If profiling later shows the query is slow enough to justify it, add the cache; the call site is the only consumer so introducing a cache is non-breaking.

**DTO (built by `project.ts` from `BlastResult`):**

```ts
type PrBlastRadiusDto = {
  counts: { symbols: number; callers: number; endpoints: number; crons: number };
  symbols: {                          // tree node per changed symbol
    name: string;
    kind: string;
    file: string;
    callers: { file: string; symbol: string; line: number }[];
    endpoints: string[];              // METHOD /path
    crons: string[];                  // schedule labels
  }[];
  degraded?: { reason: string };      // pass-through from repo-intel
};
```

The flat `impactedEndpoints` + `factsByFile` from `BlastResult` are folded into per-symbol nodes by walking `callers` and joining their `file` against `factsByFile`. UI presents the tree exactly as the screenshot shows: changed symbol header (e.g. `rateLimit()`), expandable list of caller files, terminal endpoint/cron chips per branch.

**Freshness:** key = `head_sha`. No cache row, but the response carries `headSha` so the client can detect drift if the page is open while a new commit lands (rare; we don't need to be clever about it).

**Endpoint:** `GET /api/pulls/:prId/overview/blast-radius` → `{ status: 'ready', data: PrBlastRadiusDto } | { status: 'degraded', reason } | { status: 'error', message }`. Synchronous (no SSE; query is fast).

**LLM classification pass (Q3/C's "hybrid"):** **deferred to v2.** The current `BlastResult` already separates endpoints/crons from internal callers via `factsByFile`. The LLM classification would add things like "this caller is a test", "this caller is config" — useful, but not required to ship the screenshot. Punt to a follow-up spec; leaves the DTO unchanged (caller objects can grow a `kind: 'internal'|'test'|'config'` later).

### 5.4 Prior PRs

**Source:** SQL query over existing tables. No cache.

```sql
SELECT DISTINCT ON (pr.id) pr.id, pr.number, pr.title, pr.merged_at
FROM pr_files f
JOIN pull_requests pr ON pr.id = f.pr_id
WHERE f.file_path = ANY($1::text[])      -- changed files of current PR
  AND pr.id != $2                         -- exclude self
  AND pr.merged_at IS NOT NULL            -- merged only
ORDER BY pr.id, pr.merged_at DESC
LIMIT 5;
```

**DTO:**

```ts
type PrPriorPrsDto = {
  prs: { number: number; title: string; mergedAt: string }[];
};
```

**Endpoint:** `GET /api/pulls/:prId/overview/prior-prs` → `{ status: 'ready', data: PrPriorPrsDto }`. Synchronous.

## 6. HTTP surface

All endpoints scoped under the existing pulls module pattern; new file `server/src/modules/overview/routes.ts` is registered alongside.

| Method | Path | Returns |
|--------|------|---------|
| GET    | `/api/pulls/:prId/overview/brief`            | Brief (sync) |
| GET    | `/api/pulls/:prId/overview/intent`           | Intent (sync hit / `computing` miss) |
| GET    | `/api/pulls/:prId/overview/intent/stream`    | SSE stream of intent run progress + final |
| POST   | `/api/pulls/:prId/overview/intent/refresh`   | Force recompute; returns `{ runId }` |
| GET    | `/api/pulls/:prId/overview/blast-radius`     | Blast Radius (sync) |
| POST   | `/api/pulls/:prId/overview/blast-radius/refresh` | Forces a `repo-intel` reindex of changed files, then returns fresh data |
| GET    | `/api/pulls/:prId/overview/prior-prs`        | Prior PRs (sync) |

Auth/tenancy: same workspace-scoped guard pattern as `pulls/routes.ts` — go through the base-repository's `workspaceId` constraint.

## 7. UI

`OverviewTab.tsx` becomes:

```tsx
<>
  <PrBriefCard prId={prId} />
  <div style={s.twoCol}>
    <IntentCard prId={prId} />
    <BlastRadiusCard prId={prId} />
  </div>
  <PriorPrsCard prId={prId} />
  {prBody && <DescriptionSection body={prBody} />}
</>
```

Each Card owns its query and its loading/error/empty states. `SectionFooter` is shared and shows `Computed Xs ago · Refresh`. The existing description block stays at the bottom (collapsible).

Visual notes from the screenshot we honor:
- Verdict pill colour follows existing `VerdictBanner` palette.
- PR Score is a small donut (re-use Recharts donut from elsewhere if present, else inline SVG).
- Blast Radius tree uses monospace for file paths and the existing `Icon.GitBranch`/`Icon.Globe` set.
- Risk chips use the closed icon set listed in `PrIntentDto.riskAreas.icon`.

A "Tree ↔ Graph" toggle is **in the design but Graph mode is v2** — toggle is rendered disabled with a tooltip until the graph view ships.

## 8. Testing strategy

- **Server unit tests** (`*.test.ts`):
  - `brief/aggregate.test.ts` — verdict precedence, score mean, blocker count, no-runs path.
  - `intent/extract.test.ts` — LLM call mocked via `adapters/mocks`; verifies Zod schema enforcement.
  - `blast-radius/project.test.ts` — given a fixture `BlastResult`, asserts the folded tree.
  - `prior-prs/query.test.ts` — table-driven unit test of dedup + ordering (no DB).
- **Server integration tests** (`*.it.test.ts`):
  - `overview/routes.it.test.ts` — exercise each endpoint against a seeded DB.
  - Verifies freshness keys: identical request hits cache; head_sha bump recomputes intent.
- **Client component tests** (RTL):
  - One test per card asserting loading → ready, refresh button, error state.
- **e2e:** new flow `e2e/specs/pr-overview.flow.json` opens a PR with a known seed and asserts the four blocks render. No LLM call in e2e — Intent endpoint is stubbed at the adapter boundary the way the existing e2e suite stubs reviews.

## 9. Out of scope (explicit non-goals)

- Graph view of Blast Radius (Tree only in v1).
- LLM classification pass on callers (kind: internal/test/config). Future spec.
- Editing intent in the UI. Read-only.
- Bulk recompute across many PRs. Manual per-PR only.
- Backfilling Intent for historic PRs.
- Updating `Run Review` to also kick off Intent. They stay decoupled.

## 10. Risks & open questions

- **`pr_intent` already exists with `intent` column** — the new code writes to it but treats it as authoritative. If any other code path ever populates it (none today), we'd race. Mitigation: a single writer (the `overview` module's service).
- **`repo-intel.getBlastRadius` degraded mode** — when the index is missing/stale, the call returns `degraded: true` with empty data. UI must render a clear "Indexing pending — kick a reindex" CTA, not a misleading "0 callers".
- **Intent cost** — one LLM call per PR view (after a push). For a busy local dev day that's still <100 calls — acceptable for local-first. Settings should not require a paid model for Intent; a cheap small-context model is fine.
- **Body hash on private PR descriptions** — `pr.body` may legitimately be empty; `sha256('')` is fine and deterministic.
- **Migration ordering** — `pr_intent` schema extension must precede service deploys. Standard `pnpm db:migrate` flow handles this; the project's policy is "migrations never auto-apply on boot", so a deploy step is required.

## 11. Phasing

The plan splits cleanly into independently-mergeable slices:

1. **Slice A — Brief (smallest):** server aggregator + endpoint + `PrBriefCard`. Lights up the verdict block from existing runs. Pure aggregation, no cache, no schema change.
2. **Slice B — Prior PRs:** one SQL query + endpoint + `PriorPrsCard`. Tiny.
3. **Slice C — Blast Radius:** projection layer + endpoint + `BlastRadiusCard`. Uses existing `repo-intel`.
4. **Slice D — Intent:** schema migration + LLM extractor + endpoint + SSE + `IntentCard`. The largest slice; ship last.

Each slice is a separate PR; the Overview tab progressively gains cards.
