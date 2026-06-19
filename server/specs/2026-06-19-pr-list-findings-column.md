# PR List FINDINGS Column — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh column to the PR list table showing per-severity finding counts, with a hover-tooltip listing the top finding titles for each severity and click-to-deep-link into the PR detail page.

**Architecture:** Findings counts + top-5 titles per severity ride along on the existing `GET /repos/:id/pulls` response (single round-trip; one new counts query and one new top-N window-function query). The frontend composes the existing `SeverityBadge` from `@devdigest/ui/primitives` with a small in-file hover popover. No schema changes, no migrations, no new endpoints. Spec: [2026-06-19-pr-list-findings-column-design.md](./2026-06-19-pr-list-findings-column-design.md).

**Tech Stack:** Fastify 5 + Drizzle (server), Next.js 15 + React 19 + TanStack Query (client), Zod for boundary validation, Vitest for tests, Postgres 16 (real DB via `test/helpers/pg.ts` for integration tests).

## Global Constraints

- All integration test filenames MUST end in `.it.test.ts` (per server/CLAUDE.md). Unit tests end in `.test.ts`.
- Routes register Zod schemas at the boundary; do NOT skip the schema update.
- No raw `throw new Error()` in route handlers; use types from `platform/errors.ts`.
- Reuse existing `SeverityBadge` from `@devdigest/ui/primitives` ([client/src/vendor/ui/primitives/Badge.tsx:52](../../client/src/vendor/ui/primitives/Badge.tsx)). Do NOT introduce a parallel severity helper.
- No new npm dependencies. Tooltip is a ~30-line in-file React component using `onMouseEnter`/`onMouseLeave`.
- Findings filter: `dismissed_at IS NULL`. Accepted findings ARE counted.
- "Latest review" = latest `reviews` row with `kind = 'review'` per `pr_id`, ordered by `created_at DESC` — matches the existing SCORE query in the same handler.
- Top titles ordering: `confidence DESC`, limit 5 per (pr_id, severity).
- Commit messages: english, single-quoted via `git commit -m '...'` (per repo CLAUDE.md).
- `findings` is a REQUIRED field on `PrMeta` (per pre-flight resolution). The same enrichment runs on BOTH `GET /repos/:id/pulls` (list) and `GET /pulls/:id` (detail, via `PrDetail = PrMeta.extend(...)`). Adapters that return `PrMeta[]` (Octokit, Mock) fill in empty buckets `{ count: 0, titles: [] }` since they don't have DB access — actual findings are layered on by the route handlers downstream.

---

### Task 1: Extend `PrMeta` Zod schema with `findings` + adapter shims

**Files:**
- Modify: `server/src/vendor/shared/contracts/platform.ts:157-174` (also mirrored in `client/src/vendor/shared/contracts/platform.ts` — both files are kept in sync by vendoring; edit both).
- Modify: `server/src/adapters/github/octokit.ts` (the `listPullRequests` method around line 36) — populate empty findings buckets on each returned PR.
- Modify: `server/src/adapters/mocks.ts` (the `MockGitHubClient.listPullRequests` method around line 138) — same empty-buckets population.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PrMeta.findings` field shape — `{ CRITICAL: SeverityBucket, WARNING: SeverityBucket, SUGGESTION: SeverityBucket }` where `SeverityBucket = { count: number; titles: Array<{ id: string; title: string }> }`. Both `PrMeta` (Zod) and the inferred TypeScript type are exported. The field is required; producers without DB access (the GH adapters) return empty buckets that route handlers overwrite. A shared helper `emptyFindingsBuckets()` (in the same `contracts/platform.ts` file, exported) returns the zero-state object so adapters and route handlers don't drift.

- [ ] **Step 1: Add the SeverityBucket sub-schema, the `emptyFindingsBuckets()` helper, and extend `PrMeta`** in `server/src/vendor/shared/contracts/platform.ts`

```typescript
// Insert just above the existing `export const PrMeta = z.object({` at line 157.
const FindingTitle = z.object({
  id: z.string(),
  title: z.string(),
});
const SeverityBucket = z.object({
  count: z.number().int().nonnegative(),
  titles: z.array(FindingTitle),
});

/**
 * Zero-state findings shape used by producers that don't have findings data
 * (e.g., GitHub adapters returning raw PR metadata). Route handlers overwrite
 * with real data when present.
 */
export const emptyFindingsBuckets = () => ({
  CRITICAL: { count: 0, titles: [] as Array<{ id: string; title: string }> },
  WARNING: { count: 0, titles: [] as Array<{ id: string; title: string }> },
  SUGGESTION: { count: 0, titles: [] as Array<{ id: string; title: string }> },
});

// Inside PrMeta object, immediately after `score: z.number().int().nullish(),`:
findings: z.object({
  CRITICAL: SeverityBucket,
  WARNING: SeverityBucket,
  SUGGESTION: SeverityBucket,
}),
```

- [ ] **Step 2: Mirror the same edit in `client/src/vendor/shared/contracts/platform.ts`** so the vendored copies stay in sync. The two files are kept identical by design.

- [ ] **Step 3: Update `server/src/adapters/github/octokit.ts` `listPullRequests`** so each returned PR carries empty buckets. Around line 36, where the method maps GitHub PR rows to `PrMeta`, add `findings: emptyFindingsBuckets()` to the object literal. Import the helper from `@devdigest/shared`.

- [ ] **Step 4: Update `server/src/adapters/mocks.ts` `MockGitHubClient.listPullRequests`** the same way — every returned PR gets `findings: emptyFindingsBuckets()`. Import from `@devdigest/shared`.

- [ ] **Step 5: Update the list-endpoint return at `server/src/modules/pulls/routes.ts:135`** to also include `findings: emptyFindingsBuckets()` for now — Task 2 will replace this with real values. This keeps the route's `Promise<PrMeta[]>` return type valid between tasks.

- [ ] **Step 6: Update the detail-endpoint return at `server/src/modules/pulls/routes.ts:160`** (the `GET /pulls/:id` handler returning `PrDetail`) to include `findings: emptyFindingsBuckets()`. Task 3.5 will replace this with real values.

- [ ] **Step 7: Run server typecheck + existing server tests**

Run: `pnpm -C server typecheck && pnpm -C server test`
Expected: clean typecheck, all existing tests still passing (the empty buckets satisfy the new schema; behavior unchanged).

- [ ] **Step 8: Commit**

```bash
git add server/src/vendor/shared/contracts/platform.ts \
  client/src/vendor/shared/contracts/platform.ts \
  server/src/adapters/github/octokit.ts \
  server/src/adapters/mocks.ts \
  server/src/modules/pulls/routes.ts
git commit -m 'feat(shared): extend PrMeta with per-severity findings buckets

Adds the findings field (required) and an emptyFindingsBuckets() helper.
Adapters and route handlers populate empty buckets for now; subsequent
tasks layer in real counts and titles.'
```

---

### Task 2: Backend — counts query + integration test

**Files:**
- Modify: `server/src/modules/pulls/routes.ts` (the handler that begins around line 30, returning the PR list). Specifically: add a new counts query after the existing latest-review query (~line 121), and add `findings` to each returned row at ~line 135.
- Create: `server/test/pulls-list-findings.it.test.ts`.

**Interfaces:**
- Consumes: `PrMeta.findings` shape from Task 1.
- Produces: `GET /repos/:id/pulls` now returns each PR with `findings.{CRITICAL|WARNING|SUGGESTION}.count` populated from the latest review. `titles` arrays are still empty `[]` after this task — they get populated in Task 3.

- [ ] **Step 1: Write the failing integration test** (`server/test/pulls-list-findings.it.test.ts`)

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { eq } from 'drizzle-orm';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('GET /repos/:id/pulls — findings counts', () => {
  let pg: PgFixture;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repoId: string;
  let prAId: string; // PR with 2 CRITICAL + 1 WARNING
  let prBId: string; // PR with 0 findings

  beforeAll(async () => {
    pg = await startPg();
    const cfg = loadConfig({ DATABASE_URL: pg.url, NODE_ENV: 'test' });
    app = await buildApp({
      config: cfg,
      adapters: { github: new MockGitHubClient(), git: new MockGitClient() },
    });
    await seed(app.container.db);
  });

  afterAll(async () => {
    await app.close();
    await pg.stop();
  });

  beforeEach(async () => {
    // Clear and reseed findings + reviews + PRs scoped to one repo per test.
    // (Use schema helpers — exact reset SQL depends on test/helpers/pg.ts
    // conventions; copy the pattern from server/test/pulls-comments.it.test.ts.)
    // Then insert two PRs (A, B) under one workspace+repo, one review per PR,
    // and 3 findings on PR A's review (2 CRITICAL, 1 WARNING, all
    // dismissed_at IS NULL). Capture repoId, prAId, prBId for the assertion.
  });

  it('returns severity-bucketed counts per PR from the latest review', async () => {
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; findings: any }>;
    const a = body.find((p) => p.id === prAId)!;
    const b = body.find((p) => p.id === prBId)!;
    expect(a.findings.CRITICAL.count).toBe(2);
    expect(a.findings.WARNING.count).toBe(1);
    expect(a.findings.SUGGESTION.count).toBe(0);
    expect(b.findings.CRITICAL.count).toBe(0);
    expect(b.findings.WARNING.count).toBe(0);
    expect(b.findings.SUGGESTION.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C server exec vitest run pulls-list-findings.it`
Expected: FAIL — either compilation error ("findings" not in PrMeta-shaped response) or assertion failure (`findings` is undefined on body items).

- [ ] **Step 3: Implement the counts query in `server/src/modules/pulls/routes.ts`**

After the existing latest-review IN-query (around line 121), add:

```typescript
// Per-severity finding counts on the LATEST review per PR. One IN-query +
// JS grouping, same pattern as the score query above. Dismissed findings
// are excluded; accepted findings still count (they're still real issues).
type SevKey = 'CRITICAL' | 'WARNING' | 'SUGGESTION';
const emptyBucket = (): { count: number; titles: { id: string; title: string }[] } => ({
  count: 0,
  titles: [],
});
const emptyFindings = (): Record<SevKey, ReturnType<typeof emptyBucket>> => ({
  CRITICAL: emptyBucket(),
  WARNING: emptyBucket(),
  SUGGESTION: emptyBucket(),
});

const findingsByPr = new Map<string, Record<SevKey, ReturnType<typeof emptyBucket>>>();
if (prIds.length > 0) {
  const latestReviewIds = Array.from(latestReviewByPr.entries())
    .map(([, v]) => v.reviewId)
    .filter((id): id is string => !!id);

  if (latestReviewIds.length > 0) {
    const countRows = await container.db
      .select({
        prId: t.reviews.prId,
        severity: t.findings.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
      .where(
        and(
          inArray(t.reviews.id, latestReviewIds),
          isNull(t.findings.dismissedAt),
        ),
      )
      .groupBy(t.reviews.prId, t.findings.severity);

    for (const row of countRows) {
      const sev = row.severity as SevKey;
      if (sev !== 'CRITICAL' && sev !== 'WARNING' && sev !== 'SUGGESTION') continue;
      const bucket = findingsByPr.get(row.prId) ?? emptyFindings();
      bucket[sev].count = row.count;
      findingsByPr.set(row.prId, bucket);
    }
  }
}
```

**Important — update the existing `latestReviewByPr`** at line 119 to also carry the review's `id` (currently it carries only `score`):

```typescript
const latestReviewByPr = new Map<string, { score: number | null; reviewId: string }>();
// ...
const reviewRows = await container.db
  .select({ id: t.reviews.id, prId: t.reviews.prId, score: t.reviews.score })
  .from(t.reviews)
  .where(and(inArray(t.reviews.prId, prIds), eq(t.reviews.kind, 'review')))
  .orderBy(desc(t.reviews.createdAt));
for (const rv of reviewRows) {
  if (!latestReviewByPr.has(rv.prId)) {
    latestReviewByPr.set(rv.prId, { score: rv.score, reviewId: rv.id });
  }
}
```

**Add the missing imports** at the top of the file (likely already partial):

```typescript
import { and, eq, desc, inArray, isNull, sql } from 'drizzle-orm';
```

**Inject `findings` into the response** at the end of the handler (around line 135 where the row map runs):

```typescript
return rows.map((r) => {
  const review = latestReviewByPr.get(r.id);
  return {
    // ...existing fields...
    score: review ? review.score : null,
    findings: findingsByPr.get(r.id) ?? emptyFindings(),
  };
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C server exec vitest run pulls-list-findings.it`
Expected: PASS — counts match the seeded data.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/pulls/routes.ts server/test/pulls-list-findings.it.test.ts
git commit -m 'feat(pulls): per-severity finding counts on PR list endpoint'
```

---

### Task 3: Backend — top-5 titles query + dismissed-exclusion + ordering tests + remove stale comment

**Files:**
- Modify: `server/src/modules/pulls/routes.ts` — add the top-N titles query alongside the counts query, populate the `titles` arrays. Also delete/replace the misleading comment at lines 115-117.
- Modify: `server/test/pulls-list-findings.it.test.ts` — append two more tests.

**Interfaces:**
- Consumes: response shape from Task 2.
- Produces: `findings[severity].titles` now populated with up to 5 finding titles per (pr_id, severity), ordered by `confidence DESC`. Dismissed findings still excluded.

- [ ] **Step 1: Write the two failing tests** (append to `server/test/pulls-list-findings.it.test.ts`)

```typescript
it('returns top 5 titles per severity ordered by confidence DESC', async () => {
  // In beforeEach, seed PR A's latest review with 7 CRITICAL findings,
  // confidence values [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7] and titles
  // T01..T07. (Use a dedicated describe block or extend beforeEach to seed
  // this variant — keep deterministic ordering so the assertion can be
  // exact rather than set-based.)
  const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
  const body = res.json() as Array<{ id: string; findings: any }>;
  const a = body.find((p) => p.id === prAId)!;
  expect(a.findings.CRITICAL.titles).toHaveLength(5);
  expect(a.findings.CRITICAL.titles.map((t: any) => t.title)).toEqual([
    'T07', 'T06', 'T05', 'T04', 'T03', // confidence DESC
  ]);
});

it('excludes dismissed findings from both counts and titles', async () => {
  // Seed PR A with 2 CRITICAL findings, one of them with dismissed_at set
  // to a non-null timestamp.
  const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
  const body = res.json() as Array<{ id: string; findings: any }>;
  const a = body.find((p) => p.id === prAId)!;
  expect(a.findings.CRITICAL.count).toBe(1);
  expect(a.findings.CRITICAL.titles).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C server exec vitest run pulls-list-findings.it`
Expected: the two new tests FAIL — `titles` is `[]`.

- [ ] **Step 3: Add the top-5 titles query in `server/src/modules/pulls/routes.ts`**

Insert immediately after the counts query (inside the same `if (latestReviewIds.length > 0)` block, after the count loop):

```typescript
// Top 5 titles per (pr_id, severity) by confidence DESC. Drizzle's raw
// SQL is required for the window function — kept inline and short.
const titleRows = await container.db.execute<{
  pr_id: string;
  severity: string;
  id: string;
  title: string;
}>(sql`
  SELECT pr_id, severity, id, title FROM (
    SELECT r.pr_id, f.severity, f.id, f.title,
      ROW_NUMBER() OVER (
        PARTITION BY r.pr_id, f.severity
        ORDER BY f.confidence DESC, f.id ASC
      ) AS rn
    FROM ${t.findings} f
    JOIN ${t.reviews} r ON r.id = f.review_id
    WHERE r.id = ANY(${latestReviewIds})
      AND f.dismissed_at IS NULL
  ) ranked
  WHERE rn <= 5
`);

for (const row of titleRows.rows ?? titleRows) {
  const sev = row.severity as SevKey;
  if (sev !== 'CRITICAL' && sev !== 'WARNING' && sev !== 'SUGGESTION') continue;
  const bucket = findingsByPr.get(row.pr_id) ?? emptyFindings();
  bucket[sev].titles.push({ id: row.id, title: row.title });
  findingsByPr.set(row.pr_id, bucket);
}
```

Note: `db.execute()`'s return shape differs between drizzle versions. If the code uses `node-postgres`, results live on `.rows`; with `postgres.js` it's the array directly. The `??` above tolerates both; remove the fallback once you confirm which is used in this repo (`grep -rn "db.execute" server/src` will show prior art — copy that pattern).

- [ ] **Step 4: Remove the stale comment** at the original line 115-117 (the one that says findings are intentionally NOT surfaced). Replace with a one-liner:

```typescript
// Latest-review score AND per-severity findings (counts + top-5 titles).
// Both keyed off the same `latestReviewIds` so they stay consistent — if
// "latest review" semantics ever change, change them in both places.
```

- [ ] **Step 5: Run all three tests**

Run: `pnpm -C server exec vitest run pulls-list-findings.it`
Expected: PASS — all 3 tests green.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/pulls/routes.ts server/test/pulls-list-findings.it.test.ts
git commit -m 'feat(pulls): top-5 finding titles per severity on PR list

Adds a window-function query that surfaces the highest-confidence findings
per severity bucket. Drops the now-stale comment that said findings were
intentionally not on the list.'
```

---

### Task 3.5: Backend — wire findings into the detail endpoint `GET /pulls/:id`

**Files:**
- Modify: `server/src/modules/pulls/routes.ts` — the `GET /pulls/:id` handler around line 160. Reuse the same per-severity counts query and top-5 titles window-function query from Tasks 2-3, scoped to a single `pr_id`.
- Modify: `server/test/pulls-list-findings.it.test.ts` — append a test for the detail endpoint.

**Interfaces:**
- Consumes: `emptyFindingsBuckets()` helper (Task 1) and the query patterns from Tasks 2-3.
- Produces: `GET /pulls/:id` now returns real per-severity counts + top-5 titles, computed from the same "latest review" definition as the list endpoint. Same filters apply (`dismissed_at IS NULL`).

- [ ] **Step 1: Write the failing test** (append to `server/test/pulls-list-findings.it.test.ts`)

```typescript
it('GET /pulls/:id returns findings on the detail response', async () => {
  // Seed PR A with 2 CRITICAL (titles 'detail-T1' confidence 0.9,
  // 'detail-T2' confidence 0.7) and 0 of others. prAId reused from
  // beforeEach.
  const res = await app.inject({ method: 'GET', url: `/pulls/${prAId}` });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { findings: any };
  expect(body.findings.CRITICAL.count).toBe(2);
  expect(body.findings.CRITICAL.titles.map((t: any) => t.title)).toEqual([
    'detail-T1', 'detail-T2',
  ]);
  expect(body.findings.WARNING.count).toBe(0);
  expect(body.findings.SUGGESTION.count).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C server exec vitest run pulls-list-findings.it`
Expected: FAIL — counts are 0 / titles are [] because the detail endpoint still returns `emptyFindingsBuckets()` from Task 1.

- [ ] **Step 3: Extract a reusable helper** at the top of `server/src/modules/pulls/routes.ts` (above the route registrations):

```typescript
/**
 * Compute per-severity findings (counts + top-5 titles) for the given PR ids,
 * scoped to each PR's latest 'review' kind. Returns a Map keyed by pr_id.
 * Used by both the list endpoint and the detail endpoint to keep the
 * "latest review" semantics consistent.
 */
async function computeFindingsByPr(
  db: typeof container.db, // (or import the right type from your DB module)
  prIds: string[],
): Promise<Map<string, ReturnType<typeof emptyFindingsBuckets>>> {
  const out = new Map<string, ReturnType<typeof emptyFindingsBuckets>>();
  if (prIds.length === 0) return out;

  // Latest review per PR (kind='review'), reusing the score-query semantics.
  const reviewRows = await db
    .select({ id: t.reviews.id, prId: t.reviews.prId })
    .from(t.reviews)
    .where(and(inArray(t.reviews.prId, prIds), eq(t.reviews.kind, 'review')))
    .orderBy(desc(t.reviews.createdAt));

  const latestReviewIdByPr = new Map<string, string>();
  for (const rv of reviewRows) {
    if (!latestReviewIdByPr.has(rv.prId)) latestReviewIdByPr.set(rv.prId, rv.id);
  }
  const latestReviewIds = Array.from(latestReviewIdByPr.values());
  if (latestReviewIds.length === 0) return out;

  // Counts.
  const countRows = await db
    .select({
      prId: t.reviews.prId,
      severity: t.findings.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(t.findings)
    .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
    .where(and(inArray(t.reviews.id, latestReviewIds), isNull(t.findings.dismissedAt)))
    .groupBy(t.reviews.prId, t.findings.severity);

  for (const row of countRows) {
    const sev = row.severity as 'CRITICAL' | 'WARNING' | 'SUGGESTION';
    if (sev !== 'CRITICAL' && sev !== 'WARNING' && sev !== 'SUGGESTION') continue;
    const bucket = out.get(row.prId) ?? emptyFindingsBuckets();
    bucket[sev].count = row.count;
    out.set(row.prId, bucket);
  }

  // Titles.
  const titleRows = await db.execute<{
    pr_id: string;
    severity: string;
    id: string;
    title: string;
  }>(sql`
    SELECT pr_id, severity, id, title FROM (
      SELECT r.pr_id, f.severity, f.id, f.title,
        ROW_NUMBER() OVER (
          PARTITION BY r.pr_id, f.severity
          ORDER BY f.confidence DESC, f.id ASC
        ) AS rn
      FROM ${t.findings} f
      JOIN ${t.reviews} r ON r.id = f.review_id
      WHERE r.id = ANY(${latestReviewIds})
        AND f.dismissed_at IS NULL
    ) ranked
    WHERE rn <= 5
  `);

  for (const row of titleRows.rows ?? titleRows) {
    const sev = row.severity as 'CRITICAL' | 'WARNING' | 'SUGGESTION';
    if (sev !== 'CRITICAL' && sev !== 'WARNING' && sev !== 'SUGGESTION') continue;
    const bucket = out.get(row.pr_id) ?? emptyFindingsBuckets();
    bucket[sev].titles.push({ id: row.id, title: row.title });
    out.set(row.pr_id, bucket);
  }

  return out;
}
```

- [ ] **Step 4: Refactor Task 2/3's inline queries to call `computeFindingsByPr(container.db, prIds)`**

In the list endpoint, replace the inline counts and titles queries (added in Tasks 2-3) with one call:

```typescript
const findingsByPr = await computeFindingsByPr(container.db, prIds);
```

Then `findings: findingsByPr.get(r.id) ?? emptyFindingsBuckets()` in the row map (unchanged).

- [ ] **Step 5: Use the same helper in the detail endpoint** at line 160. After fetching the PR row from the DB, add:

```typescript
const findingsByPr = await computeFindingsByPr(container.db, [pr.id]);
const findings = findingsByPr.get(pr.id) ?? emptyFindingsBuckets();
// then include `findings` in the response object.
```

- [ ] **Step 6: Run all tests in the findings file**

Run: `pnpm -C server exec vitest run pulls-list-findings.it`
Expected: PASS — all 4 tests green (3 list + 1 detail).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/pulls/routes.ts server/test/pulls-list-findings.it.test.ts
git commit -m 'feat(pulls): wire findings into detail endpoint via shared helper

Extracts computeFindingsByPr() so both GET /repos/:id/pulls and
GET /pulls/:id share the same "latest review" semantics for findings.'
```

---

### Task 4: Frontend — upgrade `PrRowView.findings` type

**Files:**
- Modify: `client/src/lib/types.ts:38-48`.

**Interfaces:**
- Consumes: the response shape from Task 2 + Task 3 (via vendored shared types, already updated in Task 1).
- Produces: `PrRowView.findings` now matches `{ CRITICAL: SeverityBucket, WARNING: SeverityBucket, SUGGESTION: SeverityBucket }`.

- [ ] **Step 1: Replace the existing `findings` field** in `client/src/lib/types.ts`

Replace line 45 (`findings: { CRITICAL: number; WARNING: number; SUGGESTION: number };`) with:

```typescript
findings: {
  CRITICAL:   { count: number; titles: Array<{ id: string; title: string }> };
  WARNING:    { count: number; titles: Array<{ id: string; title: string }> };
  SUGGESTION: { count: number; titles: Array<{ id: string; title: string }> };
};
```

- [ ] **Step 2: Run client typecheck**

Run: `pnpm -C client typecheck`
Expected: clean (PrRowView has no current consumers — verified during brainstorming; if a consumer appears, it will surface here).

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/types.ts
git commit -m 'feat(client): upgrade PrRowView.findings to counts + titles'
```

---

### Task 5: Create `FindingsCell` component — render three severity badges

**Files:**
- Create: `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.tsx`
- Create: `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/index.ts`
- Create: `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.test.tsx`

**Interfaces:**
- Consumes: `PrMeta.findings` (Task 1).
- Produces: a `<FindingsCell pr={pr} repoId={repoId} />` component rendering three `SeverityBadge` instances with counts. No tooltip yet. If all three counts are zero, renders an em-dash placeholder (matches the SCORE convention for unreviewed PRs).

- [ ] **Step 1: Write the failing component test** (`FindingsCell.test.tsx`)

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingsCell } from './FindingsCell';
import type { PrMeta } from '@devdigest/shared';

const pr = (findings: PrMeta['findings']): PrMeta =>
  ({
    id: 'pr-1',
    number: 1,
    title: 't',
    author: 'a',
    branch: 'b',
    base: 'main',
    head_sha: 's',
    additions: 0,
    deletions: 0,
    files_count: 0,
    status: 'needs_review',
    score: 70,
    findings,
  } as PrMeta);

describe('FindingsCell', () => {
  it('renders all three severity badges with their counts', () => {
    render(
      <FindingsCell
        pr={pr({
          CRITICAL: { count: 2, titles: [] },
          WARNING: { count: 0, titles: [] },
          SUGGESTION: { count: 5, titles: [] },
        })}
        repoId="r1"
      />,
    );
    expect(screen.getByLabelText(/critical/i)).toHaveTextContent('2');
    expect(screen.getByLabelText(/warning/i)).toHaveTextContent('0');
    expect(screen.getByLabelText(/suggestion/i)).toHaveTextContent('5');
  });

  it('renders an em-dash when there is no review (score is null)', () => {
    render(
      <FindingsCell
        pr={
          {
            ...pr({
              CRITICAL: { count: 0, titles: [] },
              WARNING: { count: 0, titles: [] },
              SUGGESTION: { count: 0, titles: [] },
            }),
            score: null,
          } as PrMeta
        }
        repoId="r1"
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C client exec vitest run FindingsCell`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FindingsCell.tsx`**

```tsx
"use client";

import React from "react";
import { SeverityBadge } from "@devdigest/ui";
import type { PrMeta } from "@devdigest/shared";

type SevKey = "CRITICAL" | "WARNING" | "SUGGESTION";
const SEVERITIES: SevKey[] = ["CRITICAL", "WARNING", "SUGGESTION"];

export function FindingsCell({ pr, repoId: _repoId }: { pr: PrMeta; repoId: string }) {
  const reviewed = pr.score != null;
  if (!reviewed) return <span style={{ color: "var(--text-muted)" }}>—</span>;

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {SEVERITIES.map((sev) => {
        const bucket = pr.findings[sev];
        return (
          <span key={sev} aria-label={`${sev.toLowerCase()} findings`}>
            <SeverityBadge severity={sev} compact />
            <span style={{ marginLeft: 4 }} className="mono">
              {bucket.count}
            </span>
          </span>
        );
      })}
    </div>
  );
}
```

Create the barrel file `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/index.ts`:

```typescript
export { FindingsCell } from "./FindingsCell";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C client exec vitest run FindingsCell`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/repos/\[repoId\]/pulls/_components/FindingsCell
git commit -m 'feat(client): FindingsCell component renders severity counts'
```

---

### Task 6: `FindingsCell` — add hover tooltip with titles + click-to-deep-link

**Files:**
- Modify: `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.tsx` — add an in-file `<Tooltip>` and wire badge hover.
- Modify: `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.test.tsx` — add hover/click tests.

**Interfaces:**
- Consumes: same as Task 5.
- Produces: hovering any non-zero severity badge opens a popover listing up to 5 titles, ordered as the API returned them (confidence DESC). Clicking a title navigates to `/repos/:repoId/pulls/:number?tab=findings#finding-<id>`. If the bucket has more than 5 entries (`count > titles.length`), a footer link reads `+N more` and navigates to `/repos/:repoId/pulls/:number?tab=findings&severity=<SEV>`.

- [ ] **Step 1: Write the failing tooltip test** (append to `FindingsCell.test.tsx`)

```typescript
import userEvent from '@testing-library/user-event';

it('shows finding titles on hover and deep-links on click', async () => {
  const push = vi.fn();
  vi.mock('next/navigation', () => ({
    useRouter: () => ({ push }),
  }));

  const { rerender } = render(
    <FindingsCell
      pr={pr({
        CRITICAL: {
          count: 2,
          titles: [
            { id: 'f1', title: 'Rate limit bypass' },
            { id: 'f2', title: 'Auth check skipped' },
          ],
        },
        WARNING: { count: 0, titles: [] },
        SUGGESTION: { count: 0, titles: [] },
      })}
      repoId="r1"
    />,
  );

  const user = userEvent.setup();
  const badge = screen.getByLabelText(/critical/i);
  await user.hover(badge);

  // Tooltip should appear with both titles
  expect(await screen.findByText('Rate limit bypass')).toBeInTheDocument();
  expect(screen.getByText('Auth check skipped')).toBeInTheDocument();

  await user.click(screen.getByText('Rate limit bypass'));
  expect(push).toHaveBeenCalledWith(
    expect.stringContaining('/pulls/1?tab=findings#finding-f1'),
  );
});

it('shows "+N more" link when count exceeds titles length', async () => {
  render(
    <FindingsCell
      pr={pr({
        CRITICAL: {
          count: 8,
          titles: [
            { id: 'f1', title: 'A' },
            { id: 'f2', title: 'B' },
            { id: 'f3', title: 'C' },
            { id: 'f4', title: 'D' },
            { id: 'f5', title: 'E' },
          ],
        },
        WARNING: { count: 0, titles: [] },
        SUGGESTION: { count: 0, titles: [] },
      })}
      repoId="r1"
    />,
  );
  const user = userEvent.setup();
  await user.hover(screen.getByLabelText(/critical/i));
  expect(await screen.findByText(/\+3 more/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C client exec vitest run FindingsCell`
Expected: FAIL — tooltip text not in the document.

- [ ] **Step 3: Replace `FindingsCell.tsx` with the tooltip-enabled version**

```tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { SeverityBadge } from "@devdigest/ui";
import type { PrMeta } from "@devdigest/shared";

type SevKey = "CRITICAL" | "WARNING" | "SUGGESTION";
const SEVERITIES: SevKey[] = ["CRITICAL", "WARNING", "SUGGESTION"];
const HOVER_DELAY_MS = 150;

function Tooltip({
  severity,
  bucket,
  baseHref,
  onTitleClick,
  open,
}: {
  severity: SevKey;
  bucket: PrMeta["findings"]["CRITICAL"];
  baseHref: string;
  onTitleClick: (id: string) => void;
  open: boolean;
}) {
  if (!open) return null;
  const overflow = Math.max(0, bucket.count - bucket.titles.length);
  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        marginTop: 6,
        zIndex: 10,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 8,
        minWidth: 240,
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
        {severity} ({bucket.count})
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {bucket.titles.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onTitleClick(t.id)}
              style={{
                background: "transparent",
                border: 0,
                color: "var(--text)",
                textAlign: "left",
                padding: "4px 0",
                cursor: "pointer",
                width: "100%",
              }}
            >
              • {t.title}
            </button>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <a
          href={`${baseHref}?tab=findings&severity=${severity}`}
          style={{
            display: "inline-block",
            marginTop: 4,
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          +{overflow} more
        </a>
      )}
    </div>
  );
}

function SeverityCell({
  severity,
  bucket,
  baseHref,
  onTitleClick,
}: {
  severity: SevKey;
  bucket: PrMeta["findings"]["CRITICAL"];
  baseHref: string;
  onTitleClick: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
  };
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), HOVER_DELAY_MS);
  };

  return (
    <span
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }}
      aria-label={`${severity.toLowerCase()} findings`}
      aria-describedby={open ? `tooltip-${severity}` : undefined}
    >
      <SeverityBadge severity={severity} compact />
      <span className="mono">{bucket.count}</span>
      <Tooltip
        severity={severity}
        bucket={bucket}
        baseHref={baseHref}
        onTitleClick={onTitleClick}
        open={open && bucket.titles.length > 0}
      />
    </span>
  );
}

export function FindingsCell({ pr, repoId }: { pr: PrMeta; repoId: string }) {
  const router = useRouter();
  const reviewed = pr.score != null;
  if (!reviewed) return <span style={{ color: "var(--text-muted)" }}>—</span>;

  const baseHref = `/repos/${repoId}/pulls/${pr.number}`;
  const onTitleClick = (id: string) =>
    router.push(`${baseHref}?tab=findings#finding-${id}`);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {SEVERITIES.map((sev) => (
        <SeverityCell
          key={sev}
          severity={sev}
          bucket={pr.findings[sev]}
          baseHref={baseHref}
          onTitleClick={onTitleClick}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C client exec vitest run FindingsCell`
Expected: PASS — all four tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/repos/\[repoId\]/pulls/_components/FindingsCell
git commit -m 'feat(client): hover tooltip on FindingsCell lists titles and deep-links'
```

---

### Task 7: Wire `FindingsCell` into the table — header, GRID, PRRow, i18n

**Files:**
- Modify: `client/src/app/repos/[repoId]/pulls/constants.ts:27` (GRID) and `:42-49` (COLUMN_KEYS).
- Modify: `client/src/app/repos/[repoId]/pulls/_components/PRRow/PRRow.tsx` — insert `<FindingsCell />` between status and updated cells.
- Modify: `client/messages/en/prReview.json` — add `findings` column label.

**Interfaces:**
- Consumes: `FindingsCell` (Tasks 5+6).
- Produces: the rendered PR list now has 7 columns; FINDINGS appears between STATUS and UPDATED.

- [ ] **Step 1: Update GRID and COLUMN_KEYS** in `client/src/app/repos/[repoId]/pulls/constants.ts`

Replace line 27:

```typescript
// 7 columns: pullRequest | author | size | score | status | findings | updated
export const GRID = "1fr 132px 92px 60px 118px 140px 78px";
```

Replace `COLUMN_KEYS` (lines 42-49):

```typescript
export const COLUMN_KEYS: string[] = [
  "pullRequest",
  "author",
  "size",
  "score",
  "status",
  "findings",
  "updated",
];
```

- [ ] **Step 2: Add the i18n label** in `client/messages/en/prReview.json`

Inside the existing `"columns"` object, add a `findings` key between `status` and `updated`:

```json
"columns": {
  "pullRequest": "Pull request",
  "author": "Author",
  "size": "Size",
  "score": "Score",
  "status": "Status",
  "findings": "Findings",
  "updated": "Updated"
},
```

- [ ] **Step 3: Insert `<FindingsCell />` into `PRRow.tsx`**

Open `client/src/app/repos/[repoId]/pulls/_components/PRRow/PRRow.tsx`. After the existing Status `<div>` (the one containing `<Badge dot color={st.c} ...>`), and BEFORE the Updated `<div style={s.updatedCell}>`, insert:

```tsx
<div>
  <FindingsCell pr={pr} repoId={repoId} />
</div>
```

Add the import at the top:

```typescript
import { FindingsCell } from "../FindingsCell";
```

- [ ] **Step 4: Run client typecheck + the full vitest suite**

Run: `pnpm -C client typecheck && pnpm -C client test`
Expected: clean typecheck, all existing tests still green plus the FindingsCell tests passing.

- [ ] **Step 5: Smoke-test in the browser**

In the running dev environment (server on :3101, client on :3000), open `/repos/<id>/pulls`. Confirm visually:
- Seven columns. FINDINGS appears between STATUS and UPDATED.
- Reviewed PRs show three severity badges with counts. Unreviewed PRs show `—`.
- Hovering a non-zero badge opens the tooltip after ~150ms; titles render; clicking a title navigates to the detail page.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/repos/\[repoId\]/pulls/constants.ts client/src/app/repos/\[repoId\]/pulls/_components/PRRow/PRRow.tsx client/messages/en/prReview.json
git commit -m 'feat(client): wire FindingsCell into PR list table'
```

---

### Task 8: `FindingsTab` — read `?severity=` query and scroll to `#finding-<id>`

**Files:**
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx` (172 lines).

**Interfaces:**
- Consumes: deep-link URLs produced by `FindingsCell` (Task 6) — `?tab=findings&severity=<SEV>` and `#finding-<id>`.
- Produces: when the page loads with `?severity=CRITICAL` (etc.), only that severity's findings render. When the URL has `#finding-<id>`, the page scrolls that finding into view on mount.

- [ ] **Step 1: Read the current FindingsTab to identify the filter location**

Open `client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx`. Locate (a) where findings are filtered for rendering, and (b) the wrapping element of each finding card. Each finding card MUST have an `id={`finding-${f.id}`}` attribute — add it if absent.

- [ ] **Step 2: Add the severity filter and the scroll-on-mount**

At the top of the component:

```typescript
"use client";

import React from "react";
import { useSearchParams } from "next/navigation";

export function FindingsTab(/* existing props */) {
  const searchParams = useSearchParams();
  const severityFilter = searchParams.get("severity"); // 'CRITICAL' | 'WARNING' | 'SUGGESTION' | null

  // ...existing data fetching / loading state...

  const visible = severityFilter
    ? findings.filter((f) => f.severity === severityFilter)
    : findings;

  // Scroll-to-anchor on mount when the hash matches a known finding.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash; // '#finding-<id>'
    if (!hash.startsWith("#finding-")) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [visible.length]); // re-run once the list has rendered

  // ...render `visible` instead of the raw findings list...
  // Each rendered card MUST have id={`finding-${f.id}`} on its outer element.
}
```

- [ ] **Step 3: Run client typecheck**

Run: `pnpm -C client typecheck`
Expected: clean.

- [ ] **Step 4: Smoke-test manually**

From the PR list, click a finding title in a `FindingsCell` tooltip. Confirm: the detail page opens, FindingsTab is active, scrolls the clicked finding into view. Then click the `+N more` link on a bucket with >5 findings — confirm only that severity is rendered.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/FindingsTab/FindingsTab.tsx
git commit -m 'feat(client): FindingsTab supports ?severity filter + scroll-to-finding'
```

---

## Self-Review

**Spec coverage:**
- UX (icons + counts + tooltip + zero-state + overflow) → Tasks 5, 6.
- Data delivery (counts + titles on same endpoint) → Tasks 2, 3.
- Backend queries + comment cleanup → Tasks 2, 3.
- Data model (Zod + types) → Task 1.
- Frontend changes (types, cell, table wiring, FindingsTab deep-link) → Tasks 4, 5, 6, 7, 8.
- Backend testing (3 tests) → Tasks 2, 3.
- Frontend testing (2 tests) → Tasks 5, 6.

**Placeholder scan:** no TBD/TODO/FIXME in any step. Two places explicitly say "copy the pattern from <file>" (Task 2 beforeEach; Task 3 db.execute() return shape) — these are not placeholders but pointers to in-repo precedent the implementer can look up directly.

**Type consistency:** `SeverityBucket` shape (`{ count, titles: [{ id, title }] }`) is identical across Task 1 (Zod), Task 4 (TS), Tasks 5/6 (component props), and the test factory in Task 5. `latestReviewByPr` now carries `{ score, reviewId }` — Task 2 reshapes it and Task 3 uses the new field.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-pr-list-findings-column.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
