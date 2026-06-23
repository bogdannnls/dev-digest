# PR Overview — Slice A: PR Brief (verdict / score / cost) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the near-empty Overview tab on `/repos/:repoId/pulls/:number` with a single composite **PR Brief** card at the top — verdict pill, summary, findings/blockers count, PR score, total token cost — driven by aggregating existing `reviews` + `findings` + `agent_runs` rows for the PR. No LLM, no cache, no schema migration. This is the smallest end-to-end slice of the PR Overview feature (spec §11/Slice A).

**Architecture:** New `server/src/modules/overview/` Fastify module (routes → service → repository, with a pure `brief/aggregate.ts` for the math). One synchronous endpoint `GET /api/pulls/:prId/overview/brief` returns `{ status: 'ready', data: PrOverviewBrief } | { status: 'no_runs' }`. New shared contract `PrOverviewBrief` (Zod) mirrored in `server/src/vendor/shared/` and `client/src/vendor/shared/`. New React Query hook `useOverviewBrief(prId)`. New `PrBriefCard` rendered at the top of `OverviewTab.tsx`.

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres, Zod, fastify-type-provider-zod, TanStack Query 5, React 19, `@devdigest/ui` (SectionLabel, Skeleton, ErrorState).

## Global Constraints

- Integration tests: filename suffix `*.it.test.ts`, import DB helpers from `server/test/helpers/pg.ts`.
- No raw `fetch`/`octokit` in `server/src/modules/`. Aggregation is DB-only via Drizzle.
- Errors in route handlers must extend `server/src/platform/errors.ts` (`AppError` / `NotFoundError`). No bare `throw new Error()`.
- Workspace scoping is enforced via the same pattern as `pulls/routes.ts` — resolve `workspaceId` from `getContext(container, req)`, then verify the PR belongs to it.
- Shared contracts live in BOTH `server/src/vendor/shared/contracts/` and `client/src/vendor/shared/contracts/` — keep both in sync after every change, or the typecheck breaks in one package.
- The existing `PrBrief` Zod (in `contracts/brief.ts`) is something **different** (intent + blast + risks + history). We use a non-clashing name: **`PrOverviewBrief`**.
- All client server access goes through `client/src/lib/api.ts`. No raw `fetch` in components.
- Run `pnpm typecheck` in `server/` after each server task and `pnpm typecheck` in `client/` after each client task before committing.
- Migrations are append-only. **This slice adds no migration** — verify before committing.
- Each task ends with a local commit (CLAUDE.md global rule). Use single quotes for messages.

---

## File map

**New files:**
- `server/src/vendor/shared/contracts/overview.ts`
- `client/src/vendor/shared/contracts/overview.ts`
- `server/src/modules/overview/routes.ts`
- `server/src/modules/overview/service.ts`
- `server/src/modules/overview/repository.ts`
- `server/src/modules/overview/brief/aggregate.ts`
- `server/src/modules/overview/brief/aggregate.test.ts`
- `server/test/overview-brief.it.test.ts`
- `client/src/lib/hooks/overview.ts`
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PrBriefCard/PrBriefCard.tsx`
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PrBriefCard/index.ts`
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PrBriefCard/PrBriefCard.test.tsx`

**Modified files:**
- `server/src/vendor/shared/index.ts` — export `./contracts/overview.js`
- `client/src/vendor/shared/index.ts` — export `./contracts/overview.js`
- `server/src/modules/index.ts` — register `overview` module
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx` — render `<PrBriefCard prId={prId} />` at the top, accept `prId` prop
- `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` — pass `prId` to `<OverviewTab />`

---

### Task 1: Shared contract — `PrOverviewBrief` (Zod, both mirrors)

**Files:**
- Create: `server/src/vendor/shared/contracts/overview.ts`
- Create: `client/src/vendor/shared/contracts/overview.ts`
- Modify: `server/src/vendor/shared/index.ts`
- Modify: `client/src/vendor/shared/index.ts`

**Interfaces:**
- Produces (named so as not to clash with the existing `PrBrief` in `brief.ts`):
  ```ts
  type PrOverviewBriefVerdict = 'approve' | 'request_changes' | 'comment' | 'no_runs';
  type PrOverviewBrief = {
    verdict: PrOverviewBriefVerdict;
    summary: string;          // 1-2 sentences from the worst-verdict review
    findingsCount: number;
    blockersCount: number;
    score: number | null;     // 0-100 mean over reviews.score where not null
    totalCost: { tokensIn: number; tokensOut: number; usd: number };
    computedAt: string;       // ISO
    basedOnRunIds: string[];
  };
  type PrOverviewBriefResponse =
    | { status: 'ready'; data: PrOverviewBrief }
    | { status: 'no_runs' };
  ```

- [ ] **Step 1: Write the contract (server mirror)**

Create `server/src/vendor/shared/contracts/overview.ts`:

```ts
import { z } from 'zod';

/**
 * PR Overview tab — Slice A: Brief.
 *
 * NOTE: this is intentionally NOT named `PrBrief` because `./brief.ts`
 * already exports a `PrBrief` Zod that represents a different composite
 * (intent + blast + risks + history). Slice A's "brief" is a small
 * aggregation card driven by existing reviews/findings/agent_runs.
 */
export const PrOverviewBriefVerdict = z.enum([
  'approve',
  'request_changes',
  'comment',
  'no_runs',
]);
export type PrOverviewBriefVerdict = z.infer<typeof PrOverviewBriefVerdict>;

export const PrOverviewBriefCost = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type PrOverviewBriefCost = z.infer<typeof PrOverviewBriefCost>;

export const PrOverviewBrief = z.object({
  verdict: PrOverviewBriefVerdict,
  summary: z.string(),
  findingsCount: z.number().int().nonnegative(),
  blockersCount: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100).nullable(),
  totalCost: PrOverviewBriefCost,
  computedAt: z.string(),
  basedOnRunIds: z.array(z.string()),
});
export type PrOverviewBrief = z.infer<typeof PrOverviewBrief>;

export const PrOverviewBriefResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), data: PrOverviewBrief }),
  z.object({ status: z.literal('no_runs') }),
]);
export type PrOverviewBriefResponse = z.infer<typeof PrOverviewBriefResponse>;
```

- [ ] **Step 2: Mirror to the client copy**

Copy the same file verbatim to `client/src/vendor/shared/contracts/overview.ts` (same imports, same content — the two `vendor/shared` trees are a hard-mirror).

- [ ] **Step 3: Export from both barrels**

In `server/src/vendor/shared/index.ts`, after the `./contracts/brief.js` line, add:

```ts
export * from './contracts/overview.js';
```

Do the same in `client/src/vendor/shared/index.ts`.

- [ ] **Step 4: Verify both packages typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm typecheck
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add server/src/vendor/shared/contracts/overview.ts server/src/vendor/shared/index.ts client/src/vendor/shared/contracts/overview.ts client/src/vendor/shared/index.ts && git status && git diff --cached --stat && git commit -m 'Add PrOverviewBrief shared contract for Overview tab Slice A'
```

---

### Task 2: Pure aggregator (TDD) — `brief/aggregate.ts`

**Files:**
- Create: `server/src/modules/overview/brief/aggregate.ts`
- Create: `server/src/modules/overview/brief/aggregate.test.ts`

**Interfaces:**
- Consumes:
  ```ts
  type ReviewRowSlim = {
    id: string;
    runId: string | null;
    verdict: 'approve' | 'request_changes' | 'comment' | null;
    summary: string | null;
    score: number | null;
    createdAt: Date;
  };
  type FindingRowSlim = { reviewId: string; severity: string };
  type RunCostRowSlim = {
    runId: string;
    tokensIn: number | null;
    tokensOut: number | null;
    /** USD cost derived per run (we compute it in the repo via priceBook). */
    usd: number;
  };
  type AggregateInput = {
    reviews: ReviewRowSlim[];
    findings: FindingRowSlim[];
    runCosts: RunCostRowSlim[];
    now: Date;
  };
  ```
- Produces: `function aggregatePrBrief(input: AggregateInput): PrOverviewBriefResponse` (from Task 1's contract).

- [ ] **Step 1: Write the failing tests first**

Create `server/src/modules/overview/brief/aggregate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregatePrBrief } from './aggregate.js';

const now = new Date('2026-06-24T12:00:00Z');

describe('aggregatePrBrief', () => {
  it('returns no_runs when there are no reviews', () => {
    const out = aggregatePrBrief({ reviews: [], findings: [], runCosts: [], now });
    expect(out).toEqual({ status: 'no_runs' });
  });

  it('picks worst verdict (request_changes > comment > approve)', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'approve', summary: 'a', score: 90, createdAt: new Date('2026-06-24T10:00:00Z') },
        { id: 'r2', runId: 'run2', verdict: 'request_changes', summary: 'b', score: 40, createdAt: new Date('2026-06-24T11:00:00Z') },
        { id: 'r3', runId: 'run3', verdict: 'comment', summary: 'c', score: 70, createdAt: new Date('2026-06-24T11:30:00Z') },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.verdict).toBe('request_changes');
    expect(out.data.summary).toBe('b'); // summary comes from the worst-verdict review
  });

  it('tie-breaks summary by recency when two reviews share the worst verdict', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'request_changes', summary: 'older', score: 30, createdAt: new Date('2026-06-24T08:00:00Z') },
        { id: 'r2', runId: 'run2', verdict: 'request_changes', summary: 'newer', score: 50, createdAt: new Date('2026-06-24T09:00:00Z') },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.summary).toBe('newer');
  });

  it('computes score as round(mean(scores)) ignoring nulls', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'approve', summary: 's', score: 80, createdAt: now },
        { id: 'r2', runId: 'run2', verdict: 'approve', summary: 's', score: 91, createdAt: now },
        { id: 'r3', runId: 'run3', verdict: 'approve', summary: 's', score: null, createdAt: now },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.score).toBe(86); // round((80+91)/2) = 86
  });

  it('returns null score when every review.score is null', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'comment', summary: 's', score: null, createdAt: now },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.score).toBeNull();
  });

  it('counts findings; blockers = severity blocker|critical (case-insensitive)', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'request_changes', summary: 's', score: 50, createdAt: now },
      ],
      findings: [
        { reviewId: 'r1', severity: 'blocker' },
        { reviewId: 'r1', severity: 'CRITICAL' },
        { reviewId: 'r1', severity: 'warning' },
        { reviewId: 'r1', severity: 'suggestion' },
      ],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.findingsCount).toBe(4);
    expect(out.data.blockersCount).toBe(2);
  });

  it('sums totalCost across all runs that produced a review and lists basedOnRunIds', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'approve', summary: 's', score: 80, createdAt: now },
        { id: 'r2', runId: 'run2', verdict: 'approve', summary: 's', score: 90, createdAt: now },
        { id: 'r3', runId: null,   verdict: 'comment', summary: 's', score: 70, createdAt: now }, // no runId — skip cost
      ],
      findings: [],
      runCosts: [
        { runId: 'run1', tokensIn: 1000, tokensOut: 200, usd: 0.012 },
        { runId: 'run2', tokensIn: 500,  tokensOut: 100, usd: 0.006 },
      ],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.totalCost).toEqual({ tokensIn: 1500, tokensOut: 300, usd: 0.018 });
    expect(out.data.basedOnRunIds.sort()).toEqual(['run1', 'run2', 'run3'].sort());
  });
});
```

Run the test — it MUST fail because `aggregate.ts` does not exist yet:

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run src/modules/overview/brief/aggregate.test.ts
```

Expected: `Cannot find module './aggregate.js'` (or similar).

- [ ] **Step 2: Implement the aggregator**

Create `server/src/modules/overview/brief/aggregate.ts`:

```ts
import type {
  PrOverviewBriefResponse,
  PrOverviewBriefVerdict,
} from '@devdigest/shared';

export type ReviewRowSlim = {
  id: string;
  runId: string | null;
  verdict: 'approve' | 'request_changes' | 'comment' | null;
  summary: string | null;
  score: number | null;
  createdAt: Date;
};

export type FindingRowSlim = {
  reviewId: string;
  severity: string;
};

export type RunCostRowSlim = {
  runId: string;
  tokensIn: number | null;
  tokensOut: number | null;
  usd: number;
};

export type AggregateInput = {
  reviews: ReviewRowSlim[];
  findings: FindingRowSlim[];
  runCosts: RunCostRowSlim[];
  now: Date;
};

// Worst-verdict precedence per spec §5.1.
const VERDICT_RANK: Record<'approve' | 'comment' | 'request_changes', number> = {
  approve: 0,
  comment: 1,
  request_changes: 2,
};

const BLOCKER_SEVERITIES = new Set(['blocker', 'critical']);

/**
 * Pure aggregator for the Overview tab's PR Brief card.
 * No DB, no IO — fed by the repository layer.
 */
export function aggregatePrBrief(input: AggregateInput): PrOverviewBriefResponse {
  const { reviews, findings, runCosts, now } = input;

  if (reviews.length === 0) {
    return { status: 'no_runs' };
  }

  // Pick the worst verdict; tie-break by recency (most recent wins).
  let worst: ReviewRowSlim | null = null;
  for (const r of reviews) {
    if (!r.verdict) continue;
    if (!worst) {
      worst = r;
      continue;
    }
    const cmp = VERDICT_RANK[r.verdict] - VERDICT_RANK[worst.verdict!];
    if (cmp > 0 || (cmp === 0 && r.createdAt > worst.createdAt)) {
      worst = r;
    }
  }

  // If somehow no review carried a verdict, treat as no_runs.
  if (!worst || !worst.verdict) {
    return { status: 'no_runs' };
  }

  const verdict: PrOverviewBriefVerdict = worst.verdict;
  const summary = worst.summary ?? '';

  const scoreValues = reviews.map((r) => r.score).filter((s): s is number => s != null);
  const score = scoreValues.length
    ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length)
    : null;

  const findingsCount = findings.length;
  const blockersCount = findings.filter((f) =>
    BLOCKER_SEVERITIES.has(f.severity.toLowerCase()),
  ).length;

  const totalCost = runCosts.reduce(
    (acc, c) => ({
      tokensIn: acc.tokensIn + (c.tokensIn ?? 0),
      tokensOut: acc.tokensOut + (c.tokensOut ?? 0),
      usd: acc.usd + c.usd,
    }),
    { tokensIn: 0, tokensOut: 0, usd: 0 },
  );

  const basedOnRunIds = Array.from(
    new Set(reviews.map((r) => r.runId).filter((id): id is string => !!id)),
  );

  return {
    status: 'ready',
    data: {
      verdict,
      summary,
      findingsCount,
      blockersCount,
      score,
      totalCost,
      computedAt: now.toISOString(),
      basedOnRunIds,
    },
  };
}
```

- [ ] **Step 3: Run the test green**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run src/modules/overview/brief/aggregate.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 4: Typecheck and commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
cd /Users/pandpbsa/Projects/dev-digest && git add server/src/modules/overview/brief/ && git status && git diff --cached --stat && git commit -m 'Add pure PR Brief aggregator with TDD unit tests'
```

---

### Task 3: Repository + service — read rows for one PR

**Files:**
- Create: `server/src/modules/overview/repository.ts`
- Create: `server/src/modules/overview/service.ts`

**Interfaces:**
- Repository produces:
  ```ts
  type OverviewBriefInputs = {
    reviews: ReviewRowSlim[];
    findings: FindingRowSlim[];
    runCosts: RunCostRowSlim[];
  };
  class OverviewRepository {
    constructor(db: Db);
    getPull(workspaceId: string, prId: string): Promise<PullRow | undefined>;
    getBriefInputs(prId: string, estimateCost: (model: string|null, tokensIn: number, tokensOut: number) => number | null): Promise<OverviewBriefInputs>;
  }
  ```
- Service produces:
  ```ts
  class OverviewService {
    constructor(container: Container);
    getBrief(workspaceId: string, prId: string): Promise<PrOverviewBriefResponse>;
  }
  ```

- [ ] **Step 1: Write the repository**

Create `server/src/modules/overview/repository.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';
import type {
  ReviewRowSlim,
  FindingRowSlim,
  RunCostRowSlim,
} from './brief/aggregate.js';

export type OverviewBriefInputs = {
  reviews: ReviewRowSlim[];
  findings: FindingRowSlim[];
  runCosts: RunCostRowSlim[];
};

/**
 * Read-only access for the Overview tab. Slice A only needs the per-PR
 * review/finding/run-cost rows; no writes, no cache table.
 */
export class OverviewRepository {
  constructor(private db: Db) {}

  async getPull(workspaceId: string, prId: string): Promise<PullRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  /**
   * Load every review for the PR (kind='review'), its findings, and the
   * cost of the agent_runs that produced them. USD is computed here via
   * the injected price-book estimator so the aggregator stays pure.
   */
  async getBriefInputs(
    prId: string,
    estimateCost: (model: string | null, tokensIn: number, tokensOut: number) => number | null,
  ): Promise<OverviewBriefInputs> {
    const reviewRows = await this.db
      .select({
        id: t.reviews.id,
        runId: t.reviews.runId,
        verdict: t.reviews.verdict,
        summary: t.reviews.summary,
        score: t.reviews.score,
        createdAt: t.reviews.createdAt,
      })
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.kind, 'review')));

    const reviews: ReviewRowSlim[] = reviewRows.map((r) => ({
      id: r.id,
      runId: r.runId,
      verdict:
        r.verdict === 'approve' || r.verdict === 'request_changes' || r.verdict === 'comment'
          ? r.verdict
          : null,
      summary: r.summary,
      score: r.score,
      createdAt: r.createdAt as Date,
    }));

    if (reviews.length === 0) {
      return { reviews: [], findings: [], runCosts: [] };
    }

    const reviewIds = reviews.map((r) => r.id);
    const runIds = Array.from(
      new Set(reviews.map((r) => r.runId).filter((id): id is string => !!id)),
    );

    const findingRows = await this.db
      .select({ reviewId: t.findings.reviewId, severity: t.findings.severity })
      .from(t.findings)
      .where(inArray(t.findings.reviewId, reviewIds));
    const findings: FindingRowSlim[] = findingRows.map((f) => ({
      reviewId: f.reviewId,
      severity: f.severity,
    }));

    let runCosts: RunCostRowSlim[] = [];
    if (runIds.length > 0) {
      const runRows = await this.db
        .select({
          id: t.agentRuns.id,
          model: t.agentRuns.model,
          tokensIn: t.agentRuns.tokensIn,
          tokensOut: t.agentRuns.tokensOut,
        })
        .from(t.agentRuns)
        .where(inArray(t.agentRuns.id, runIds));
      runCosts = runRows.map((r) => ({
        runId: r.id,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        usd: estimateCost(r.model ?? null, r.tokensIn ?? 0, r.tokensOut ?? 0) ?? 0,
      }));
    }

    return { reviews, findings, runCosts };
  }
}
```

- [ ] **Step 2: Write the service**

Create `server/src/modules/overview/service.ts`:

```ts
import type { Container } from '../../platform/container.js';
import type { PrOverviewBriefResponse } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { OverviewRepository } from './repository.js';
import { aggregatePrBrief } from './brief/aggregate.js';

/**
 * Overview module — Slice A.
 * Orchestrates: load rows → aggregate → return. No cache, no LLM.
 */
export class OverviewService {
  private repo: OverviewRepository;

  constructor(private container: Container) {
    this.repo = new OverviewRepository(container.db);
  }

  async getBrief(workspaceId: string, prId: string): Promise<PrOverviewBriefResponse> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const inputs = await this.repo.getBriefInputs(prId, (model, tIn, tOut) =>
      model ? this.container.priceBook.estimate(model, tIn, tOut) : null,
    );

    return aggregatePrBrief({ ...inputs, now: new Date() });
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add server/src/modules/overview/repository.ts server/src/modules/overview/service.ts && git status && git diff --cached --stat && git commit -m 'Add OverviewRepository + OverviewService for Slice A brief'
```

---

### Task 4: Route + module registration + integration test (TDD)

**Files:**
- Create: `server/src/modules/overview/routes.ts`
- Create: `server/test/overview-brief.it.test.ts`
- Modify: `server/src/modules/index.ts`

**Interfaces:**
- Produces HTTP: `GET /pulls/:id/overview/brief → PrOverviewBriefResponse`
  - 200 with `{ status: 'ready', data }` when reviews exist.
  - 200 with `{ status: 'no_runs' }` when none.
  - 404 if PR is not in the caller's workspace.
- The route prefix in this project does NOT include `/api` at the framework level (see `pulls/routes.ts:108` which registers `/repos/:id/pulls` directly). We follow the same pattern — the `/api` prefix in the spec is the dev-server proxy convention.

- [ ] **Step 1: Write the failing integration test first**

Create `server/test/overview-brief.it.test.ts`:

```ts
/**
 * Integration test: GET /pulls/:id/overview/brief — Slice A.
 * Verifies aggregation off real reviews + findings + agent_runs rows.
 * Gated on Docker (Testcontainers Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('GET /pulls/:id/overview/brief', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    loadConfig({ DATABASE_URL: pg.url, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await pg.stop();
  });

  beforeEach(async () => {
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: `ov-${Date.now()}`, fullName: `acme/ov-${Date.now()}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'PR for overview',
        author: 'alice',
        branch: 'feat/x',
        base: 'main',
        headSha: 'sha1',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'open',
      })
      .returning();
    prId = pr!.id;
  });

  it('returns no_runs when the PR has no reviews', async () => {
    const app = await buildApp(pg.handle.db);
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'no_runs' });
    await app.close();
  });

  it('aggregates worst verdict + score mean + blockers + cost across runs', async () => {
    // Two runs → two reviews. One request_changes (worst) + one approve.
    const [run1] = await pg.handle.db
      .insert(t.agentRuns)
      .values({ workspaceId, prId, model: 'gpt-4o-mini', tokensIn: 1000, tokensOut: 200, status: 'done' })
      .returning();
    const [run2] = await pg.handle.db
      .insert(t.agentRuns)
      .values({ workspaceId, prId, model: 'gpt-4o-mini', tokensIn: 500, tokensOut: 100, status: 'done' })
      .returning();

    const [rev1] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId,
        runId: run1!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary: 'Worst-verdict summary wins',
        score: 40,
        model: 'gpt-4o-mini',
      })
      .returning();
    const [rev2] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId,
        runId: run2!.id,
        kind: 'review',
        verdict: 'approve',
        summary: 'Other summary',
        score: 90,
        model: 'gpt-4o-mini',
      })
      .returning();

    await pg.handle.db.insert(t.findings).values([
      { reviewId: rev1!.id, file: 'a.ts', startLine: 1, endLine: 1, severity: 'blocker', category: 'bug', title: 't1', rationale: 'r', confidence: 0.9 },
      { reviewId: rev1!.id, file: 'a.ts', startLine: 2, endLine: 2, severity: 'critical', category: 'bug', title: 't2', rationale: 'r', confidence: 0.9 },
      { reviewId: rev1!.id, file: 'a.ts', startLine: 3, endLine: 3, severity: 'warning', category: 'style', title: 't3', rationale: 'r', confidence: 0.9 },
      { reviewId: rev2!.id, file: 'a.ts', startLine: 4, endLine: 4, severity: 'suggestion', category: 'nit', title: 't4', rationale: 'r', confidence: 0.9 },
    ]);

    const app = await buildApp(pg.handle.db);
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: 'ready';
      data: {
        verdict: string;
        summary: string;
        score: number | null;
        findingsCount: number;
        blockersCount: number;
        totalCost: { tokensIn: number; tokensOut: number; usd: number };
        basedOnRunIds: string[];
      };
    };
    expect(body.status).toBe('ready');
    expect(body.data.verdict).toBe('request_changes');
    expect(body.data.summary).toBe('Worst-verdict summary wins');
    expect(body.data.score).toBe(65); // round((40+90)/2)
    expect(body.data.findingsCount).toBe(4);
    expect(body.data.blockersCount).toBe(2);
    expect(body.data.totalCost.tokensIn).toBe(1500);
    expect(body.data.totalCost.tokensOut).toBe(300);
    expect(body.data.basedOnRunIds.sort()).toEqual([run1!.id, run2!.id].sort());
    await app.close();
  });

  it('returns 404 when PR is not in the caller workspace', async () => {
    // Insert a PR in a *different* workspace and try to read it.
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-ws' })
      .returning();
    const [otherRepo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId: otherWs!.id, owner: 'x', name: 'y', fullName: 'x/y' })
      .returning();
    const [otherPr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId: otherWs!.id,
        repoId: otherRepo!.id,
        number: 99,
        title: 'foreign',
        author: 'x',
        branch: 'a',
        base: 'main',
        headSha: 'zzz',
        additions: 0,
        deletions: 0,
        filesCount: 0,
        status: 'open',
      })
      .returning();

    const app = await buildApp(pg.handle.db);
    const res = await app.inject({ method: 'GET', url: `/pulls/${otherPr!.id}/overview/brief` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

Run the test — it MUST fail (no route yet):

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run test/overview-brief.it.test.ts
```

Expected: 404 from Fastify on the GET (route not registered) or skipped if Docker is unavailable. The test should not pass.

- [ ] **Step 2: Write the route plugin**

Create `server/src/modules/overview/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrOverviewBriefResponse } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { OverviewService } from './service.js';

/**
 * PR Overview tab — Slice A.
 *   GET /pulls/:id/overview/brief → PrOverviewBriefResponse
 *
 * Pure aggregation over existing reviews + findings + agent_runs.
 * No cache, no LLM. Subsequent slices add Intent / Blast Radius / Prior PRs.
 */
export default async function overviewRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new OverviewService(container);

  app.get(
    '/pulls/:id/overview/brief',
    { schema: { params: IdParams } },
    async (req): Promise<PrOverviewBriefResponse> => {
      const { workspaceId } = await getContext(container, req);
      return service.getBrief(workspaceId, req.params.id);
    },
  );
}
```

- [ ] **Step 3: Register the module**

In `server/src/modules/index.ts`, add the import and entry:

```ts
import overview from './overview/routes.js';
```

then add `overview,` to the `modules` object (keep alphabetical-ish; placing it next to `pulls` is fine).

- [ ] **Step 4: Run the integration test green**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run test/overview-brief.it.test.ts
```

Expected: 3 tests pass (or all skipped if Docker is unavailable on the machine — in CI Docker is available).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
cd /Users/pandpbsa/Projects/dev-digest && git add server/src/modules/overview/routes.ts server/src/modules/index.ts server/test/overview-brief.it.test.ts && git status && git diff --cached --stat && git commit -m 'Add GET /pulls/:id/overview/brief endpoint + integration test'
```

---

### Task 5: Client hook + API wiring

**Files:**
- Create: `client/src/lib/hooks/overview.ts`

**Interfaces:**
- Produces:
  ```ts
  function useOverviewBrief(prId: string | null | undefined): UseQueryResult<PrOverviewBriefResponse, ApiError>;
  ```
- Consumes: `api.get<PrOverviewBriefResponse>('/pulls/:id/overview/brief')`, `PrOverviewBriefResponse` from `@devdigest/shared`.

- [ ] **Step 1: Write the hook**

Create `client/src/lib/hooks/overview.ts`:

```ts
/* hooks/overview.ts — PR Overview tab queries.
   Slice A: PR Brief only (verdict / score / cost). */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { PrOverviewBriefResponse } from "@devdigest/shared";

/**
 * Synchronous brief aggregation. Cheap (one query per PR), so refetch on
 * mount is fine; staleTime keeps the card stable while the user clicks
 * around tabs without thrashing the network.
 */
export function useOverviewBrief(prId: string | null | undefined) {
  return useQuery<PrOverviewBriefResponse>({
    queryKey: ["overview-brief", prId],
    queryFn: () => api.get<PrOverviewBriefResponse>(`/pulls/${prId}/overview/brief`),
    enabled: !!prId,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add client/src/lib/hooks/overview.ts && git status && git diff --cached --stat && git commit -m 'Add useOverviewBrief client hook for Slice A'
```

---

### Task 6: `PrBriefCard` component + RTL test (TDD), wire into OverviewTab

**Files:**
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PrBriefCard/PrBriefCard.tsx`
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PrBriefCard/index.ts`
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PrBriefCard/PrBriefCard.test.tsx`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`

**Interfaces:**
- Component: `function PrBriefCard(props: { prId: string | null }): JSX.Element`
- `OverviewTab` props extended: `{ prId: string | null; prBody: string | null | undefined }`.

- [ ] **Step 1: Write the failing RTL test first**

Create `PrBriefCard.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrOverviewBriefResponse } from "@devdigest/shared";
import { PrBriefCard } from "./PrBriefCard";

// Mock the hook module so we don't hit the network in the component test.
vi.mock("../../../../../../../../lib/hooks/overview", () => ({
  useOverviewBrief: vi.fn(),
}));
import { useOverviewBrief } from "../../../../../../../../lib/hooks/overview";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("PrBriefCard", () => {
  it("renders a loading skeleton while the query is pending", () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    expect(screen.getByTestId("pr-brief-loading")).toBeInTheDocument();
  });

  it("renders an empty state when there are no runs yet", () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { status: "no_runs" } satisfies PrOverviewBriefResponse,
      isLoading: false,
      isError: false,
      error: null,
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    expect(screen.getByText(/no review runs yet/i)).toBeInTheDocument();
  });

  it("renders verdict, score, findings/blockers and cost when ready", async () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        status: "ready",
        data: {
          verdict: "request_changes",
          summary: "Tighten the auth path",
          findingsCount: 4,
          blockersCount: 2,
          score: 65,
          totalCost: { tokensIn: 1500, tokensOut: 300, usd: 0.018 },
          computedAt: "2026-06-24T12:00:00Z",
          basedOnRunIds: ["run-1", "run-2"],
        },
      } satisfies PrOverviewBriefResponse,
      isLoading: false,
      isError: false,
      error: null,
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    await waitFor(() => {
      expect(screen.getByText(/request changes/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Tighten the auth path")).toBeInTheDocument();
    expect(screen.getByText("65")).toBeInTheDocument(); // score
    expect(screen.getByText(/4 findings/i)).toBeInTheDocument();
    expect(screen.getByText(/2 blockers/i)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.018/)).toBeInTheDocument();
    expect(screen.getByText(/1,?500.*in/i)).toBeInTheDocument();
  });

  it("renders an error state when the query fails", () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    expect(screen.getByText(/couldn.t load the brief/i)).toBeInTheDocument();
  });
});
```

Run the test — it must fail (component does not exist):

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/PrBriefCard/PrBriefCard.test.tsx
```

Expected: import resolution failure.

- [ ] **Step 2: Implement the component**

Create `PrBriefCard.tsx`:

```tsx
"use client";

import React from "react";
import { Skeleton, ErrorState, SectionLabel } from "@devdigest/ui";
import { useOverviewBrief } from "../../../../../../../../lib/hooks/overview";

interface PrBriefCardProps {
  prId: string | null;
}

const VERDICT_LABEL: Record<string, string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
  no_runs: "No reviews yet",
};

const VERDICT_COLOR: Record<string, string> = {
  approve: "#16a34a",
  comment: "#2563eb",
  request_changes: "#dc2626",
  no_runs: "#6b7280",
};

function formatUsd(n: number): string {
  // 3 decimals up to $1, 2 above. Local-first cost numbers are usually < $1.
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function PrBriefCard({ prId }: PrBriefCardProps) {
  const { data, isLoading, isError } = useOverviewBrief(prId);

  if (isLoading || !data) {
    return (
      <section data-testid="pr-brief-loading">
        <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
        <Skeleton style={{ height: 120 }} />
      </section>
    );
  }

  if (isError) {
    return (
      <section>
        <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
        <ErrorState title="Couldn't load the brief" description="Try again in a moment." />
      </section>
    );
  }

  if (data.status === "no_runs") {
    return (
      <section>
        <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
        <div style={{ padding: 16, color: "#6b7280" }}>
          No review runs yet — kick off a review to see the verdict, score and cost here.
        </div>
      </section>
    );
  }

  const { verdict, summary, findingsCount, blockersCount, score, totalCost } = data.data;

  return (
    <section>
      <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          gap: 16,
          padding: 16,
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 8,
          alignItems: "center",
        }}
      >
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            color: "white",
            background: VERDICT_COLOR[verdict] ?? VERDICT_COLOR.no_runs,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {VERDICT_LABEL[verdict] ?? verdict}
        </span>
        <div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>{summary}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            {findingsCount} findings · {blockersCount} blockers ·{" "}
            {formatTokens(totalCost.tokensIn)} in / {formatTokens(totalCost.tokensOut)} out ·{" "}
            {formatUsd(totalCost.usd)}
          </div>
        </div>
        <div
          style={{ fontSize: 28, fontWeight: 700, color: score == null ? "#9ca3af" : undefined }}
          aria-label="PR score"
        >
          {score == null ? "—" : score}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Add the barrel**

Create `index.ts`:

```ts
export { PrBriefCard } from "./PrBriefCard";
```

- [ ] **Step 4: Run the RTL test green**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/PrBriefCard/PrBriefCard.test.tsx
```

Expected: 4 tests pass.

- [ ] **Step 5: Wire into `OverviewTab`**

Edit `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx` to:

```tsx
"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { PrBriefCard } from "./_components/PrBriefCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  prBody: string | null | undefined;
}

export function OverviewTab({ prId, prBody }: OverviewTabProps) {
  return (
    <>
      <PrBriefCard prId={prId} />
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
```

- [ ] **Step 6: Pass `prId` from the page**

In `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`, find the line:

```tsx
{tab === "overview" && <OverviewTab prBody={pr.body} />}
```

and change it to:

```tsx
{tab === "overview" && <OverviewTab prId={prId} prBody={pr.body} />}
```

(`prId` is already declared above in the same component.)

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm typecheck
cd /Users/pandpbsa/Projects/dev-digest && git add client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/PrBriefCard/ client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/OverviewTab.tsx client/src/app/repos/\[repoId\]/pulls/\[number\]/page.tsx && git status && git diff --cached --stat && git commit -m 'Render PR Brief card at top of Overview tab'
```

---

### Task 7: Cross-package verification + pre-ready review

**Files:** none (no edits). This task is a final gate.

- [ ] **Step 1: Full server tests (unit + integration where Docker is up)**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm test
```

Expected: all suites green; integration tests skipped on machines without Docker.

- [ ] **Step 2: Full client tests**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm test
```

Expected: all suites green.

- [ ] **Step 3: Typecheck both packages**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm typecheck
```

Expected: both exit 0.

- [ ] **Step 4: Confirm no migration was added**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git diff --stat main...HEAD -- server/src/db/migrations/
```

Expected: empty. Slice A must not touch migrations.

- [ ] **Step 5: Run `/pr-self-review`**

Per `CLAUDE.md` "Pre-ready architectural check": the diff touches `client/` and `server/`, so run `/pr-self-review` before claiming the slice ready. Treat MUST findings as blockers (propose a fix, ask before applying). SHOULD findings are advisory — summarize them.

- [ ] **Step 6: Engineering insights (optional but recommended)**

If anything non-obvious was discovered (Drizzle quirk, type-mirror gotcha, severity-casing in findings), invoke `/engineering-insights` to append to the appropriate `LEARNINGS.md`.

---

## Self-review checklist

- [ ] Shared contract `PrOverviewBrief` exists in BOTH `server/src/vendor/shared/contracts/overview.ts` and `client/src/vendor/shared/contracts/overview.ts` with identical content, and both `index.ts` barrels export it.
- [ ] Name does not clash with the existing `PrBrief` in `contracts/brief.ts`.
- [ ] No migration was added under `server/src/db/migrations/`.
- [ ] No new dependency in any `package.json`.
- [ ] Route handler uses `getContext` for workspace scoping and throws `NotFoundError` (not bare `Error`) for an unknown PR.
- [ ] Route uses `IdParams` Zod schema for `:id`, same pattern as `pulls/routes.ts`.
- [ ] `OverviewService` reads via `OverviewRepository` only; no Drizzle imports inside `service.ts`.
- [ ] `aggregatePrBrief` is pure (no DB, no `Date.now()` — `now` is injected) — proven by the unit test suite.
- [ ] Severity matching for blockers is case-insensitive (`blocker` / `critical` / `BLOCKER` / `CRITICAL`).
- [ ] Score is `null` when every `reviews.score` is null; otherwise `Math.round(mean)`.
- [ ] Summary comes from the worst-verdict review with recency tie-break.
- [ ] Cost is summed across runs whose IDs appear in `reviews.run_id`; runs with no review are not counted.
- [ ] USD is derived via `container.priceBook.estimate`; falls back to `0` when the price book has no entry for the model.
- [ ] `basedOnRunIds` is deduped (multiple reviews per run won't double-list).
- [ ] Client hook uses `staleTime: 30_000` and `enabled: !!prId`; query key is `["overview-brief", prId]`.
- [ ] `PrBriefCard` handles loading / error / `no_runs` / `ready` states; loading state has `data-testid="pr-brief-loading"` (the RTL test depends on it).
- [ ] `OverviewTab` now accepts `prId` and renders `PrBriefCard` ABOVE the description.
- [ ] `page.tsx` passes `prId` to `<OverviewTab />`.
- [ ] No raw `fetch` in components; all server access via `api` in `client/src/lib/api.ts`.
- [ ] Integration test covers: `no_runs`, ready with multi-run aggregation, 404 cross-workspace.
- [ ] Unit test covers: empty input, worst-verdict precedence, recency tie-break, score mean ignoring nulls, all-null score, blockers case-insensitive, cost summation + basedOnRunIds dedup.
- [ ] All commits are small, focused, English, and follow the project's style (single-quoted messages per global rules).
- [ ] `/pr-self-review` was run and any MUST findings addressed (or explicitly waived with the user).
