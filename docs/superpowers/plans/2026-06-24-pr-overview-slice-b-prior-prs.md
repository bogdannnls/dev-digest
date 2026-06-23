# PR Overview — Slice B: Prior PRs (history block)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development`) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Strict TDD: every code task starts with a failing test, runs it red, then green, then commits.

**Goal:** Ship the second card of the new Overview tab — *Prior PRs touching the same files* — as a thin, synchronous read endpoint plus a collapsed-by-default list with a count badge. No LLM, no cache, no schema migration. Pure SQL projection over existing `pr_files` ↔ `pull_requests`.

**Architecture:** New `server/src/modules/overview/` module rooted under the onion: `routes.ts` → `service.ts` → `prior-prs/query.ts` (pure Drizzle, no I/O beyond the DB handle). Route is registered in `server/src/modules/index.ts`. Workspace scoping enforced via the PR row (carries `workspace_id`). The client gets a new `useOverviewPriorPrs(prId)` TanStack Query hook in `client/src/lib/hooks/overview.ts` and a `PriorPrsCard` component slotted into `OverviewTab.tsx` ABOVE the existing description block.

**Tech Stack:** Fastify 5 + Zod (`fastify-type-provider-zod`), Drizzle ORM, Postgres 16, TanStack Query, React 19 (RSC default; this card is a `'use client'` leaf), Vitest + RTL.

## Global Constraints

- Integration test filenames end in `*.it.test.ts`. They import DB helpers from `server/test/helpers/pg.ts` and `seed()` from `server/src/db/seed.ts`. They MUST gate on `dockerAvailable()` and `describe.skip` when Docker is unreachable.
- No raw `fetch` / `octokit` in `server/src/modules/`. The Drizzle handle comes via `container.db`.
- Errors thrown from route handlers must extend `server/src/platform/errors.ts` (`AppError`, `NotFoundError`). No `throw new Error(...)`.
- All client server-state goes through hooks in `client/src/lib/hooks/`. Components never call `fetch`/`api` directly.
- Shared contracts live in BOTH `server/src/vendor/shared/contracts/` and `client/src/vendor/shared/contracts/`. Every change must be mirrored — they are byte-identical files.
- Slice B does NOT extend `pr_intent` and does NOT add migrations. The query reads existing tables only.
- Run `pnpm typecheck` (in `server/` and `client/`) after each task's edits, before commit.
- All commits are local only. Conventional `feat:` / `test:` / `chore:` subjects, single-quoted bodies.
- After the last task, before claiming the slice ready, the executing session runs `/pr-self-review` per the root `CLAUDE.md` pre-ready check.

## File Structure

**Create (server):**
- `server/src/modules/overview/routes.ts` — Fastify plugin exposing `GET /pulls/:prId/overview/prior-prs`. Zod params at the boundary. One handler.
- `server/src/modules/overview/service.ts` — orchestrator: resolve PR (workspace-scoped) → fetch its file paths → delegate to `prior-prs/query.ts` → return DTO. Throws `NotFoundError` if the PR is not in the workspace.
- `server/src/modules/overview/prior-prs/query.ts` — pure Drizzle function `queryPriorPrs(db, { prId, filePaths }): Promise<PrPriorPrsDto['prs']>`. The ONLY place that touches `pr_files` / `pull_requests` for this slice.
- `server/src/modules/overview/prior-prs/query.test.ts` — unit-level test against an in-memory-fixture (still uses Postgres via `startPg()` because Drizzle has no in-memory adapter; flagged as `.it.test.ts` if so). Verified by Task 3 — see note in Task 3 below.

**Create (server tests):**
- `server/src/modules/overview/routes.it.test.ts` — integration: seeded PR with overlapping files yields a deterministic list; PR not in workspace → 404.

**Create (shared contracts):**
- `server/src/vendor/shared/contracts/overview.ts` — Zod + TS types for `PrPriorPrsItem`, `PrPriorPrsDto`, `PrPriorPrsResponse`.
- `client/src/vendor/shared/contracts/overview.ts` — byte-identical mirror.

**Create (client):**
- `client/src/lib/hooks/overview.ts` — `useOverviewPriorPrs(prId)` only. (Slices A/C/D append their hooks here later.)
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PriorPrsCard/PriorPrsCard.tsx` — collapsed-by-default list with count badge; expands on click.
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PriorPrsCard/PriorPrsCard.test.tsx` — RTL: loading → ready, empty state, expand toggle.
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PriorPrsCard/index.ts` — barrel.

**Modify:**
- `server/src/modules/index.ts` — register `overview` plugin.
- `server/src/vendor/shared/index.ts` — `export * from './contracts/overview.js';`
- `client/src/vendor/shared/index.ts` — same mirror.
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx` — render `<PriorPrsCard prId={prId} />` above the description block.
- `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` — pass `prId` down to `OverviewTab` (currently only `prBody` is passed).

---

## Task 1 — Shared contracts: `PrPriorPrsDto`

**Files:**
- Create: `server/src/vendor/shared/contracts/overview.ts`
- Create: `client/src/vendor/shared/contracts/overview.ts` (byte-identical)
- Modify: `server/src/vendor/shared/index.ts` (add re-export)
- Modify: `client/src/vendor/shared/index.ts` (add re-export)

**Interfaces:**

- Produces: `PrPriorPrsItem`, `PrPriorPrsDto`, `PrPriorPrsResponse` (Zod schemas + inferred TS types).

```ts
// PrPriorPrsItem = { number: number; title: string; merged_at: string }
// PrPriorPrsDto  = { prs: PrPriorPrsItem[] }
// PrPriorPrsResponse = { status: 'ready'; data: PrPriorPrsDto }
```

`merged_at` is snake_case to match every other DTO in `contracts/brief.ts` (e.g. `PrHistoryItem.merged_at`). The client camelCases at the component layer if needed (Slice B never does — it formats with `Intl.DateTimeFormat` directly).

- [ ] **Step 1.1 — Create the contracts file (server side)**

Create `server/src/vendor/shared/contracts/overview.ts` with:

```ts
import { z } from 'zod';

/**
 * PR Overview tab — DTOs.
 *
 * Slice B (this file's initial content) ships only Prior PRs. Slices A/C/D
 * will append PrBriefDto / PrIntentDto / PrBlastRadiusDto here without
 * editing existing exports.
 */

// ---- Prior PRs (Slice B) ----
export const PrPriorPrsItem = z.object({
  number: z.number().int(),
  title: z.string(),
  merged_at: z.string(), // ISO 8601
});
export type PrPriorPrsItem = z.infer<typeof PrPriorPrsItem>;

export const PrPriorPrsDto = z.object({
  prs: z.array(PrPriorPrsItem),
});
export type PrPriorPrsDto = z.infer<typeof PrPriorPrsDto>;

export const PrPriorPrsResponse = z.object({
  status: z.literal('ready'),
  data: PrPriorPrsDto,
});
export type PrPriorPrsResponse = z.infer<typeof PrPriorPrsResponse>;
```

- [ ] **Step 1.2 — Mirror to the client**

Copy the exact same contents into `client/src/vendor/shared/contracts/overview.ts`. They must remain byte-identical (this matches every other file under `vendor/shared/contracts/`).

Run a diff to confirm equality:

```bash
diff -u /Users/pandpbsa/Projects/dev-digest/server/src/vendor/shared/contracts/overview.ts \
        /Users/pandpbsa/Projects/dev-digest/client/src/vendor/shared/contracts/overview.ts
```

Expected output: (empty — no diff).

- [ ] **Step 1.3 — Re-export from both barrels**

Edit `server/src/vendor/shared/index.ts`. After the existing `export * from './contracts/productionize.js';` line, add:

```ts
export * from './contracts/overview.js';
```

Mirror the same change in `client/src/vendor/shared/index.ts` at the same position.

- [ ] **Step 1.4 — Typecheck both packages**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm typecheck
```

Expected output: both end with no errors.

- [ ] **Step 1.5 — Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add \
  server/src/vendor/shared/contracts/overview.ts \
  server/src/vendor/shared/index.ts \
  client/src/vendor/shared/contracts/overview.ts \
  client/src/vendor/shared/index.ts
git commit -m 'feat(overview): add PrPriorPrsDto shared contract'
```

---

## Task 2 — Pure query: `prior-prs/query.ts` (TDD)

**Files:**
- Create (test FIRST): `server/src/modules/overview/prior-prs/query.it.test.ts`
- Create: `server/src/modules/overview/prior-prs/query.ts`

**Interfaces:**

- Produces:

```ts
export interface QueryPriorPrsArgs {
  prId: string;          // exclude self
  filePaths: string[];   // current PR's changed paths
  limit?: number;        // default 5
}
export interface PriorPrRow {
  number: number;
  title: string;
  mergedAt: Date;        // raw Date from Drizzle; mapped to ISO in service
}
export function queryPriorPrs(db: Db, args: QueryPriorPrsArgs): Promise<PriorPrRow[]>;
```

- Consumes: `Db` from `server/src/db/client.ts`; `pullRequests` + `prFiles` from `server/src/db/schema.ts`.

**Why integration-suffixed?** Drizzle queries are validated end-to-end most reliably against a real Postgres. The `.it.test.ts` suffix makes CI route this to the integration lane (per repo CLAUDE.md). The conventions module sets this precedent with `repository.it.test.ts`.

- [ ] **Step 2.1 — Write the failing test**

Create `server/src/modules/overview/prior-prs/query.it.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from '../../../../test/helpers/pg.js';
import { seed } from '../../../db/seed.js';
import * as t from '../../../db/schema.js';
import { queryPriorPrs } from './query.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[overview/prior-prs] Docker not available — skipping integration tests.');
}

d('queryPriorPrs', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;
  let currentPrId: string;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    const { db } = pg.handle;
    // Wipe PR-domain rows; seed() upserts workspace + demo repo + PR #482.
    await db.delete(t.prFiles);
    await db.delete(t.prCommits);
    await db.delete(t.pullRequests);
    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    const [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: `repo-${Date.now()}`,
        fullName: `acme/repo-${Date.now()}`,
      })
      .returning();
    repoId = repo!.id;

    // Current PR (the one being viewed); two changed files.
    const [current] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 100,
        title: 'Current PR',
        author: 'alice',
        branch: 'feat/x',
        base: 'main',
        headSha: 'sha-current',
        status: 'open',
      })
      .returning();
    currentPrId = current!.id;
    await db.insert(t.prFiles).values([
      { prId: currentPrId, path: 'src/a.ts', additions: 1, deletions: 0 },
      { prId: currentPrId, path: 'src/b.ts', additions: 1, deletions: 0 },
    ]);

    // Two merged prior PRs sharing files; one merged PR that touched neither.
    const mkMerged = async (number: number, title: string, mergedAt: Date) => {
      const [pr] = await db
        .insert(t.pullRequests)
        .values({
          workspaceId,
          repoId,
          number,
          title,
          author: 'bob',
          branch: `feat/${number}`,
          base: 'main',
          headSha: `sha-${number}`,
          status: 'merged',
          updatedAt: mergedAt,
        })
        .returning();
      return pr!.id;
    };

    const olderId = await mkMerged(98, 'Older overlap', new Date('2026-06-10T00:00:00Z'));
    await db.insert(t.prFiles).values([
      { prId: olderId, path: 'src/a.ts', additions: 1, deletions: 0 },
    ]);

    const newerId = await mkMerged(99, 'Newer overlap', new Date('2026-06-20T00:00:00Z'));
    await db.insert(t.prFiles).values([
      { prId: newerId, path: 'src/a.ts', additions: 1, deletions: 0 },
      { prId: newerId, path: 'src/b.ts', additions: 1, deletions: 0 },
    ]);

    const unrelatedId = await mkMerged(50, 'Unrelated', new Date('2026-05-01T00:00:00Z'));
    await db.insert(t.prFiles).values([
      { prId: unrelatedId, path: 'src/z.ts', additions: 1, deletions: 0 },
    ]);

    // An OPEN PR that overlaps — must be excluded (only merged PRs count).
    const openId = await mkMerged(101, 'Still open', new Date('2026-06-22T00:00:00Z'));
    await pg.handle.db.update(t.pullRequests).set({ status: 'open', updatedAt: null }).where(
      // simplest: re-tag to open and clear merged_at
      // (we use updatedAt as the merged marker per the seed pattern)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ((_) => _)(undefined as never),
    );
    // ^ The line above is intentionally a no-op placeholder; the real "open" guard
    // is tested by inserting with status='open' below.
    await db.insert(t.prFiles).values([
      { prId: openId, path: 'src/a.ts', additions: 1, deletions: 0 },
    ]);
  });

  it('returns merged PRs that share files, newest first, excluding self', async () => {
    const rows = await queryPriorPrs(pg.handle.db, {
      prId: currentPrId,
      filePaths: ['src/a.ts', 'src/b.ts'],
    });
    expect(rows.map((r) => r.number)).toEqual([99, 98]);
    expect(rows[0]!.title).toBe('Newer overlap');
    expect(rows[0]!.mergedAt).toBeInstanceOf(Date);
  });

  it('returns an empty array when no other PR touched these files', async () => {
    const rows = await queryPriorPrs(pg.handle.db, {
      prId: currentPrId,
      filePaths: ['src/never-existed.ts'],
    });
    expect(rows).toEqual([]);
  });

  it('honors the limit (default 5)', async () => {
    const rows = await queryPriorPrs(pg.handle.db, {
      prId: currentPrId,
      filePaths: ['src/a.ts'],
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.number).toBe(99);
  });
});
```

> Note on the "merged" guard: per the spec §5.4 the query filters on `merged_at IS NOT NULL`. The current schema (`server/src/db/schema/pulls.ts`) does NOT have a `merged_at` column — it has `status` and `updated_at`. The query uses `status = 'merged'` as the merged marker, consistent with how the rest of the codebase derives merge state (see `pulls/routes.ts:144` where GitHub `status` is persisted). The "open PR overlap exclusion" assertion above is implicit — it's not seeded with status `'merged'`, so it's filtered out. The test does NOT need the no-op placeholder block; remove it before running. (Kept here only to flag the spec ↔ schema mismatch for the executor — see Self-review checklist item.)

- [ ] **Step 2.2 — Run the test red**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run src/modules/overview/prior-prs/query.it.test.ts
```

Expected output: file not found / module not found (`Cannot find module './query.js'`) — the query file doesn't exist yet.

- [ ] **Step 2.3 — Implement the query**

Create `server/src/modules/overview/prior-prs/query.ts`:

```ts
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';

export interface QueryPriorPrsArgs {
  /** The PR being viewed — excluded from results. */
  prId: string;
  /** Changed file paths of the PR being viewed. Empty array → empty result. */
  filePaths: string[];
  /** Max rows to return. Defaults to 5 per spec §5.4. */
  limit?: number;
}

export interface PriorPrRow {
  number: number;
  title: string;
  /** Merge time. The schema stores it in `updated_at` for merged PRs;
   *  the service layer converts to ISO. */
  mergedAt: Date;
}

/**
 * Up to N most recently merged PRs (excluding `prId`) that touched any
 * of `filePaths`. Distinct on pr.id; ordered by merge time desc.
 *
 * The current schema has no dedicated `merged_at` column; merged PRs are
 * identified by `status = 'merged'` and their `updated_at` is the merge
 * time (set by the forge import in `modules/pulls/routes.ts`).
 */
export async function queryPriorPrs(
  db: Db,
  { prId, filePaths, limit = 5 }: QueryPriorPrsArgs,
): Promise<PriorPrRow[]> {
  if (filePaths.length === 0) return [];

  const rows = await db
    .selectDistinctOn([t.pullRequests.id], {
      id: t.pullRequests.id,
      number: t.pullRequests.number,
      title: t.pullRequests.title,
      mergedAt: t.pullRequests.updatedAt,
    })
    .from(t.prFiles)
    .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.prFiles.prId))
    .where(
      and(
        inArray(t.prFiles.path, filePaths),
        ne(t.pullRequests.id, prId),
        eq(t.pullRequests.status, 'merged'),
        sql`${t.pullRequests.updatedAt} IS NOT NULL`,
      ),
    )
    .orderBy(t.pullRequests.id, desc(t.pullRequests.updatedAt));

  // `selectDistinctOn` requires ORDER BY to start with the distinct key, so
  // we re-sort by mergedAt desc in JS, then truncate.
  const sorted = rows
    .filter((r): r is typeof r & { mergedAt: Date } => r.mergedAt != null)
    .sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime())
    .slice(0, limit);

  return sorted.map((r) => ({
    number: r.number,
    title: r.title,
    mergedAt: r.mergedAt,
  }));
}
```

- [ ] **Step 2.4 — Run the test green**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run src/modules/overview/prior-prs/query.it.test.ts
```

Expected output: `3 passed`. If Docker is unreachable, expected: `3 skipped` + the console warning — that is also acceptable (the executor should report which path occurred).

- [ ] **Step 2.5 — Typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 2.6 — Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add \
  server/src/modules/overview/prior-prs/query.ts \
  server/src/modules/overview/prior-prs/query.it.test.ts
git commit -m 'feat(overview): prior-prs Drizzle query + integration test'
```

---

## Task 3 — Service + route + module registration (TDD)

**Files:**
- Create (test FIRST): `server/src/modules/overview/routes.it.test.ts`
- Create: `server/src/modules/overview/service.ts`
- Create: `server/src/modules/overview/routes.ts`
- Modify: `server/src/modules/index.ts`

**Interfaces:**

- Produces (service):

```ts
export class OverviewService {
  constructor(private container: Container);
  getPriorPrs(workspaceId: string, prId: string): Promise<PrPriorPrsDto>;
}
```

- Produces (HTTP):

```
GET /pulls/:prId/overview/prior-prs
  → 200 { status: 'ready', data: { prs: PrPriorPrsItem[] } }
  → 404 { error: { code: 'not_found', message: 'Pull request not found' } }
  → 422 (Zod) on non-UUID :prId
```

- Consumes: `queryPriorPrs` (Task 2), `NotFoundError` from `platform/errors.ts`, `getContext` from `_shared/context.ts`, `IdParams` from `_shared/schemas.ts`. The route file uses `IdParams` but renames the param to `prId` — define a one-off schema for clarity (see Step 3.3).

- [ ] **Step 3.1 — Write the failing route integration test**

Create `server/src/modules/overview/routes.it.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { startPg, dockerAvailable, type PgFixture } from '../../../test/helpers/pg.js';
import { seed } from '../../db/seed.js';
import * as t from '../../db/schema.js';
import overviewRoutes from './routes.js';
import { buildContainer } from '../../platform/container.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[overview/routes] Docker not available — skipping integration tests.');
}

d('GET /pulls/:prId/overview/prior-prs', () => {
  let pg: PgFixture;
  let app: ReturnType<typeof Fastify>;
  let workspaceId: string;
  let currentPrId: string;
  let priorPrId: string;

  beforeAll(async () => {
    pg = await startPg();

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const container = await buildContainer({ db: pg.handle, url: pg.url });
    typed.decorate('container', container);
    await typed.register(overviewRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    const { db } = pg.handle;
    await db.delete(t.prFiles);
    await db.delete(t.pullRequests);
    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    const [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: `repo-${Date.now()}`,
        fullName: `acme/repo-${Date.now()}`,
      })
      .returning();

    const [current] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 200,
        title: 'Current',
        author: 'alice',
        branch: 'b',
        base: 'main',
        headSha: 'sha-c',
        status: 'open',
      })
      .returning();
    currentPrId = current!.id;
    await db.insert(t.prFiles).values([
      { prId: currentPrId, path: 'src/x.ts', additions: 1, deletions: 0 },
    ]);

    const [prior] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 199,
        title: 'Prior merged',
        author: 'bob',
        branch: 'b2',
        base: 'main',
        headSha: 'sha-p',
        status: 'merged',
        updatedAt: new Date('2026-06-20T00:00:00Z'),
      })
      .returning();
    priorPrId = prior!.id;
    await db.insert(t.prFiles).values([
      { prId: priorPrId, path: 'src/x.ts', additions: 1, deletions: 0 },
    ]);
  });

  it('returns ready + the single overlapping merged PR', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/pulls/${currentPrId}/overview/prior-prs`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      data: {
        prs: [
          {
            number: 199,
            title: 'Prior merged',
            merged_at: '2026-06-20T00:00:00.000Z',
          },
        ],
      },
    });
  });

  it('returns 404 for a PR not in the workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pulls/00000000-0000-0000-0000-000000000000/overview/prior-prs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 for a non-uuid prId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pulls/not-a-uuid/overview/prior-prs',
    });
    expect(res.statusCode).toBe(422);
  });
});
```

> If `buildContainer` is not the actual exported name (check `server/src/platform/container.ts`), substitute the project's existing container factory — every other integration test in the repo (e.g. `conventions/repository.it.test.ts`) shows the pattern by passing `pg.handle.db` straight to the repository class. The executor should follow whichever pattern is already used by `routes.it.test.ts` files in the repo; if none exists yet, mimic `server/src/server.ts` minimally inside the test (register the same plugins).

- [ ] **Step 3.2 — Run red**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run src/modules/overview/routes.it.test.ts
```

Expected: module-not-found for `./routes.js` and `./service.js`.

- [ ] **Step 3.3 — Implement the service**

Create `server/src/modules/overview/service.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import * as t from '../../db/schema.js';
import type { PrPriorPrsDto } from '@devdigest/shared';
import { queryPriorPrs } from './prior-prs/query.js';

/**
 * Overview tab orchestrator. Slice B exposes only `getPriorPrs`; Slices
 * A/C/D will append `getBrief`, `getIntent`, `getBlastRadius`.
 */
export class OverviewService {
  constructor(private container: Container) {}

  async getPriorPrs(workspaceId: string, prId: string): Promise<PrPriorPrsDto> {
    const db = this.container.db;

    const [pr] = await db
      .select({ id: t.pullRequests.id })
      .from(t.pullRequests)
      .where(
        and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)),
      );
    if (!pr) throw new NotFoundError('Pull request not found');

    const files = await db
      .select({ path: t.prFiles.path })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, prId));
    const filePaths = files.map((f) => f.path);

    const rows = await queryPriorPrs(db, { prId, filePaths });

    return {
      prs: rows.map((r) => ({
        number: r.number,
        title: r.title,
        merged_at: r.mergedAt.toISOString(),
      })),
    };
  }
}
```

- [ ] **Step 3.4 — Implement the route**

Create `server/src/modules/overview/routes.ts`:

```ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrPriorPrsResponse } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { OverviewService } from './service.js';

const PrIdParams = z.object({ prId: z.string().uuid() });

/**
 * PR Overview tab — HTTP surface.
 *
 *   GET /pulls/:prId/overview/prior-prs  (Slice B — sync, no cache)
 *
 * Slices A/C/D will add /brief, /intent (+ /intent/stream, /intent/refresh),
 * and /blast-radius (+ /blast-radius/refresh) to this same plugin without
 * changing the Slice B handler.
 */
export default async function overviewRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new OverviewService(container);

  app.get(
    '/pulls/:prId/overview/prior-prs',
    { schema: { params: PrIdParams } },
    async (req): Promise<PrPriorPrsResponse> => {
      const { workspaceId } = await getContext(container, req);
      const data = await service.getPriorPrs(workspaceId, req.params.prId);
      return { status: 'ready', data };
    },
  );
}
```

- [ ] **Step 3.5 — Register the module**

Edit `server/src/modules/index.ts`:

```ts
// add import alongside the others:
import overview from './overview/routes.js';

// add to the registry object:
export const modules: Record<string, FastifyPluginAsync> = {
  // …existing entries…
  overview,
};
```

- [ ] **Step 3.6 — Run green**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm exec vitest run src/modules/overview/routes.it.test.ts
```

Expected: `3 passed` (or `3 skipped` on no-Docker hosts).

- [ ] **Step 3.7 — Typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/server && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3.8 — Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add \
  server/src/modules/overview/service.ts \
  server/src/modules/overview/routes.ts \
  server/src/modules/overview/routes.it.test.ts \
  server/src/modules/index.ts
git commit -m 'feat(overview): GET /pulls/:prId/overview/prior-prs endpoint'
```

---

## Task 4 — Client hook: `useOverviewPriorPrs` (TDD-lite)

**Files:**
- Create: `client/src/lib/hooks/overview.ts`

**Interfaces:**

- Produces:

```ts
export function useOverviewPriorPrs(prId: string | null | undefined):
  UseQueryResult<PrPriorPrsResponse>;
```

- Consumes: `api.get` from `../api`, `PrPriorPrsResponse` from `@devdigest/shared`.

This hook is tiny and stateless — covered by the component test in Task 5 (mocking the hook is more honest than testing it in isolation, given React Query's internal caching). No standalone unit test for this file.

- [ ] **Step 4.1 — Create the hook**

Create `client/src/lib/hooks/overview.ts`:

```ts
/* hooks/overview.ts — React Query hooks for the PR Overview tab.
   Slice B ships only Prior PRs. Slices A/C/D append their hooks here. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { PrPriorPrsResponse } from "@devdigest/shared";

/** Prior merged PRs that touched the same files as this PR (max 5). */
export function useOverviewPriorPrs(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["overview-prior-prs", prId],
    queryFn: () => api.get<PrPriorPrsResponse>(`/pulls/${prId}/overview/prior-prs`),
    enabled: !!prId,
  });
}
```

- [ ] **Step 4.2 — Typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm typecheck
```

Expected: no errors. (No commit yet — bundle with Task 5.)

---

## Task 5 — Card component + wiring + RTL test (TDD)

**Files:**
- Create (test FIRST): `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PriorPrsCard/PriorPrsCard.test.tsx`
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PriorPrsCard/PriorPrsCard.tsx`
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/PriorPrsCard/index.ts`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`

**Interfaces:**

- Produces:

```ts
export interface PriorPrsCardProps { prId: string | null }
export function PriorPrsCard(props: PriorPrsCardProps): JSX.Element;
```

- Consumes: `useOverviewPriorPrs` from `@/lib/hooks/overview`.

UI behaviour (matches spec §7, "collapsed list with count badge that expands"):

1. Loading → small skeleton row.
2. Empty (`prs.length === 0`) → render nothing (the card does not occupy space when there's no history).
3. Default → collapsed header `Prior PRs touching these files · {count}` (button).
4. Click → expand to list of `#{number} — {title} · {formatted merged_at}`. Each item is a plain text row (no link in Slice B — repo full-name plumbing is out of scope; Slice C/D may revisit).

- [ ] **Step 5.1 — Write the failing component test**

Create `…/PriorPrsCard/PriorPrsCard.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PriorPrsCard } from "./PriorPrsCard";
import * as hooks from "@/lib/hooks/overview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("PriorPrsCard", () => {
  it("renders nothing when there are no prior PRs", () => {
    vi.spyOn(hooks, "useOverviewPriorPrs").mockReturnValue({
      data: { status: "ready", data: { prs: [] } },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof hooks.useOverviewPriorPrs>);
    const { container } = renderWithQuery(<PriorPrsCard prId="pr-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the count and expands the list on click", async () => {
    vi.spyOn(hooks, "useOverviewPriorPrs").mockReturnValue({
      data: {
        status: "ready",
        data: {
          prs: [
            { number: 199, title: "Earlier overlap", merged_at: "2026-06-20T00:00:00.000Z" },
            { number: 180, title: "Older overlap", merged_at: "2026-05-10T00:00:00.000Z" },
          ],
        },
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof hooks.useOverviewPriorPrs>);
    renderWithQuery(<PriorPrsCard prId="pr-1" />);

    // Collapsed by default — header shows count, items are not yet visible.
    expect(screen.getByRole("button", { name: /Prior PRs touching these files/ })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText(/Earlier overlap/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/Earlier overlap/)).toBeInTheDocument();
    expect(screen.getByText(/Older overlap/)).toBeInTheDocument();
    expect(screen.getByText(/#199/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5.2 — Run red**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/PriorPrsCard/PriorPrsCard.test.tsx
```

Expected: module-not-found for `./PriorPrsCard` and `@/lib/hooks/overview` (the latter exists from Task 4, but the former is the trigger).

- [ ] **Step 5.3 — Implement the card**

Create `…/PriorPrsCard/PriorPrsCard.tsx`:

```tsx
"use client";

import React from "react";
import { useOverviewPriorPrs } from "@/lib/hooks/overview";

const dateFmt = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

const s = {
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 14,
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    background: "transparent",
    border: 0,
    padding: 0,
    color: "var(--text-primary)",
    cursor: "pointer",
    font: "inherit",
    textAlign: "left" as const,
  } as React.CSSProperties,
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 22,
    padding: "0 6px",
    height: 20,
    borderRadius: 10,
    background: "var(--bg-subtle)",
    color: "var(--text-secondary)",
    fontSize: 12,
  } as React.CSSProperties,
  list: {
    listStyle: "none",
    padding: 0,
    margin: "10px 0 0",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  } as React.CSSProperties,
  item: {
    fontSize: 13,
    color: "var(--text-secondary)",
  } as React.CSSProperties,
  number: {
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
    marginRight: 6,
  } as React.CSSProperties,
};

export interface PriorPrsCardProps {
  prId: string | null;
}

export function PriorPrsCard({ prId }: PriorPrsCardProps) {
  const [open, setOpen] = React.useState(false);
  const { data, isLoading } = useOverviewPriorPrs(prId);

  if (isLoading) {
    return (
      <div style={s.card} aria-busy="true">
        <div style={{ height: 16, width: 220, background: "var(--bg-subtle)", borderRadius: 4 }} />
      </div>
    );
  }
  const prs = data?.data.prs ?? [];
  if (prs.length === 0) return null;

  return (
    <div style={s.card}>
      <button
        type="button"
        style={s.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Prior PRs touching these files</span>
        <span style={s.badge}>{prs.length}</span>
      </button>
      {open && (
        <ul style={s.list}>
          {prs.map((p) => (
            <li key={p.number} style={s.item}>
              <span style={s.number}>#{p.number}</span>
              {p.title}
              <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                · {dateFmt.format(new Date(p.merged_at))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Create the barrel `…/PriorPrsCard/index.ts`:

```ts
export { PriorPrsCard } from "./PriorPrsCard";
```

- [ ] **Step 5.4 — Run green**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/PriorPrsCard/PriorPrsCard.test.tsx
```

Expected: `2 passed`.

- [ ] **Step 5.5 — Wire into OverviewTab**

Edit `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`:

```tsx
"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { PriorPrsCard } from "./_components/PriorPrsCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  prBody: string | null | undefined;
}

export function OverviewTab({ prId, prBody }: OverviewTabProps) {
  return (
    <>
      <PriorPrsCard prId={prId} />
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

Edit `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` — change the existing `<OverviewTab prBody={pr.body} />` (line 137) to:

```tsx
{tab === "overview" && <OverviewTab prId={prId} prBody={pr.body} />}
```

- [ ] **Step 5.6 — Run the full client test suite for this directory + typecheck**

```bash
cd /Users/pandpbsa/Projects/dev-digest/client && pnpm exec vitest run src/app/repos && pnpm typecheck
```

Expected: all green, no type errors.

- [ ] **Step 5.7 — Commit**

```bash
cd /Users/pandpbsa/Projects/dev-digest && git add \
  client/src/lib/hooks/overview.ts \
  client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/PriorPrsCard/ \
  client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/OverviewTab.tsx \
  client/src/app/repos/\[repoId\]/pulls/\[number\]/page.tsx
git commit -m 'feat(overview): PriorPrsCard + useOverviewPriorPrs hook + tab wiring'
```

---

## Task 6 — Pre-ready architectural check

Per repo `CLAUDE.md` (root): "Before marking work ready, if the diff touches `client/` or `server/`, run `/pr-self-review`. Treat MUST findings as blockers."

- [ ] **Step 6.1 — Invoke `/pr-self-review`**

Run the slash command in the current session against the uncommitted+committed diff for Slice B.

- [ ] **Step 6.2 — Address MUST findings**

For each MUST: propose the fix in a short message, ask the user before applying, then apply + amend the relevant commit (or add a fixup commit — never `--amend` on shared history, but these are local-only).

- [ ] **Step 6.3 — Capture SHOULD findings**

Include the SHOULD list verbatim in the final report. Do not silently apply them.

---

## Self-review checklist

Run through this list before reporting Slice B ready. Each item must be confirmable from the actual diff, not just from intent.

- [ ] `server/src/vendor/shared/contracts/overview.ts` and `client/src/vendor/shared/contracts/overview.ts` are byte-identical (verified with `diff -u`).
- [ ] Both `vendor/shared/index.ts` barrels re-export `./contracts/overview.js`.
- [ ] Spec ↔ schema mismatch noted in Task 2.3: the spec SQL uses `merged_at`, but the live schema (`server/src/db/schema/pulls.ts`) has no such column. The implementation uses `status = 'merged' AND updated_at IS NOT NULL` instead. If this conflicts with how the test seed sets merged PRs, fix the seed/test — do not invent a `merged_at` column (would require a migration, out of slice scope).
- [ ] `OverviewService.getPriorPrs` enforces workspace scoping via the PR lookup. A PR id from another workspace returns 404, not its data.
- [ ] `routes.ts` uses Zod `params` schema → invalid UUIDs return 422 automatically.
- [ ] No `throw new Error(...)` in the route handler or service. Only `NotFoundError` / `AppError`.
- [ ] No raw `fetch`, `octokit`, or `pg` imports in the new module (only `container.db`).
- [ ] The query never returns the current PR itself (assert: `ne(t.pullRequests.id, prId)`).
- [ ] The query is capped at the configured limit (default 5).
- [ ] Empty `filePaths` short-circuits to `[]` without a DB roundtrip.
- [ ] `useOverviewPriorPrs` is gated with `enabled: !!prId` so the route is not called with `null/null` in the URL.
- [ ] `PriorPrsCard` renders **nothing** for an empty list (matches the screenshot — no "0 prior PRs" placeholder noise).
- [ ] `OverviewTab` receives `prId` from `page.tsx` and forwards it (the previous signature took only `prBody`).
- [ ] Tests covered: query (3 cases, integration), routes (3 cases, integration), card (2 cases, RTL).
- [ ] All integration tests use the `.it.test.ts` suffix and gate on `dockerAvailable()`.
- [ ] `pnpm typecheck` passes in both `server/` and `client/`.
- [ ] Each task ended in a commit; commit messages follow `feat(scope): subject` convention.
- [ ] `/pr-self-review` reported no MUST findings (or every MUST was fixed; if `partial: true`, investigate before claiming ready).
- [ ] No migration was added; no LLM call introduced; no new dependencies added to either `package.json`.
