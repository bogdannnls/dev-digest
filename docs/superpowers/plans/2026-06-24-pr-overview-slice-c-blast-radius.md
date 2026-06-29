# Slice C — Blast Radius (PR Overview tab)

**Spec:** `docs/superpowers/specs/2026-06-24-pr-overview-tab-design.md` (§5.3, §6, §7, §10, §11).
**Branch target:** new feature branch off `l02`.
**Slice scope:** server projection + endpoint + React Query hook + `BlastRadiusCard` wired into `OverviewTab`. No cache, no DB migration, no LLM. The LLM classification pass (Q3 "hybrid") is deferred to v2.

## Goal

Project the existing `container.repoIntel.getBlastRadius(repoId, files): BlastResult` output into a UI-friendly shape and render a Tree view (changed symbol → callers → endpoints/crons) inside the PR Overview tab. When the underlying index is missing/stale (`degraded: true`), show a "Indexing pending — kick a reindex" CTA instead of misleading zeros.

## Architecture

```
client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/
  OverviewTab.tsx                            mounts <BlastRadiusCard prId={prId} />
  _components/
    BlastRadiusCard/
      BlastRadiusCard.tsx                    counts + tree + degraded CTA + disabled Graph toggle
      BlastRadiusCard.test.tsx               RTL: ready / degraded / loading
      styles.ts
      index.ts

client/src/lib/hooks/overview.ts             new file: useOverviewBlastRadius(prId)

server/src/modules/overview/
  routes.ts                                  GET /api/pulls/:prId/overview/blast-radius
  service.ts                                 orchestrator: pr → files → repoIntel → project
  blast-radius/
    project.ts                               pure: BlastResult → BlastRadius (vendor/shared zod)
    project.test.ts                          unit tests over synthetic BlastResult fixtures
  routes.it.test.ts                          integration test against seeded DB

server/src/modules/index.ts                  register the new `overview` plugin
```

**Onion boundary:** `overview/service.ts` is the *only* place that crosses modules. It pulls `pr_files` via Drizzle, calls `container.repoIntel.getBlastRadius`, then calls `project()`. No adapter is constructed inside the module; `container.repoIntel` is the facade.

**Wire shape:** the response body reuses the existing Zod schema `BlastRadius` from `server/src/vendor/shared/contracts/brief.ts` (re-exported by `@devdigest/shared`). Fields `changed_symbols`, `downstream` (= `DownstreamImpact[]` with `symbol`, `callers[{name,file,line}]`, `endpoints_affected`, `crons_affected`), and `summary` map exactly to what spec §5.3 calls for at the symbol-tree level.

**Decision — where counts live:** the spec's `counts: { symbols, callers, endpoints, crons }` is **computed on the client** from the `BlastRadius` payload. Rationale: keeps the wire format = existing shared Zod (no thin wrapper DTO), avoids a server/client drift point, and the four numbers are a trivial reduce. The card derives them in a `useMemo`. Documented again at the top of `BlastRadiusCard.tsx`.

**Response envelope:** `{ status: 'ready', data: BlastRadius } | { status: 'degraded', reason } | { status: 'error', message }`. The `degraded` branch propagates `BlastResult.reason` (a `DegradedReason` enum string) so the UI can tell "no index yet" from "index_partial" if it wants to.

## Tech stack

- Server: Fastify 5, `fastify-type-provider-zod`, Drizzle, vitest.
- Client: Next.js 15 App Router, React 19, TanStack Query, vitest + jsdom + RTL.
- Reuse: `BlastRadius` Zod from `@devdigest/shared`, `getContext` for tenancy, `AppError`/`NotFoundError` from `platform/errors`, `api.get` from `client/src/lib/api.ts`.

## Global constraints

- No raw `fetch` in client components — go through `api.get`.
- No raw `throw new Error()` in routes — use `AppError`/`NotFoundError`.
- All external I/O via adapters; here it's `container.repoIntel` and `container.db`.
- Tests: unit `*.test.ts(x)`, integration `*.it.test.ts`. CI splits on the suffix.
- Onion: `overview/blast-radius/project.ts` is pure (no I/O, no container). Unit-testable with plain fixtures.
- Server logs via `app.log` (Pino); no `console.log` in production paths.
- Do NOT mutate or extend the existing `pr_brief` or `pr_intent` tables — this slice doesn't cache and doesn't write.
- Tree-only view in v1; Graph toggle is rendered disabled with a tooltip ("Graph view in v2").

---

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `server/src/modules/overview/blast-radius/project.ts` | Pure `project(BlastResult): BlastRadius` — folds `factsByFile` into per-symbol nodes |
| `server/src/modules/overview/blast-radius/project.test.ts` | Unit tests with synthetic fixtures (multi-symbol, multi-caller, endpoints+crons via factsByFile, degraded passthrough) |
| `server/src/modules/overview/service.ts` | `OverviewService` — loads PR + pr_files, calls `repoIntel.getBlastRadius`, returns status envelope |
| `server/src/modules/overview/routes.ts` | Fastify plugin: `GET /pulls/:id/overview/blast-radius` (sets the module up for future Slices A/B/D) |
| `server/src/modules/overview/routes.it.test.ts` | Integration test: seed pr + pr_files, mock `container.repoIntel.getBlastRadius`, assert envelope |
| `client/src/lib/hooks/overview.ts` | `useOverviewBlastRadius(prId)` React Query hook (returns the typed envelope) |
| `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/BlastRadiusCard/BlastRadiusCard.tsx` | The card: counts row, symbol tree with expand/collapse, degraded CTA |
| `…/BlastRadiusCard/BlastRadiusCard.test.tsx` | RTL: ready (tree + counts), degraded (CTA), loading, expand interaction |
| `…/BlastRadiusCard/styles.ts` | Card styles (var(--…) tokens; matches sibling cards) |
| `…/BlastRadiusCard/index.ts` | Barrel: `export { BlastRadiusCard }` |

### Modify

| Path | Reason |
|---|---|
| `server/src/modules/index.ts` | Register `overview` plugin |
| `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx` | Accept `prId`, mount `<BlastRadiusCard prId={prId} />` above the description |
| `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` | Pass `prId` into `<OverviewTab />` |

---

## Tasks

Each task is independent enough to commit on its own. Order matters: 1 → 2 → 3 → 4 → 5 → 6 → 7.

---

### Task 1 — Pure projection: `BlastResult → BlastRadius`

The heart of the slice. A pure function with no container access. Folds the flat `BlastResult` into per-symbol `DownstreamImpact[]`, attributing endpoints/crons to a symbol via the caller-file → `factsByFile` join.

**Files**

- Create: `server/src/modules/overview/blast-radius/project.ts`
- Test: `server/src/modules/overview/blast-radius/project.test.ts`

**Interfaces**

Consumes (from `server/src/modules/repo-intel/types.ts`):
```ts
import type { BlastResult, BlastChangedSymbol, BlastCallerRow } from '../../repo-intel/types.js';
```

Produces (from `@devdigest/shared`, defined in `server/src/vendor/shared/contracts/brief.ts`):
```ts
import type { BlastRadius, DownstreamImpact, BlastCaller, ChangedSymbol } from '@devdigest/shared';

export function projectBlastRadius(input: BlastResult): BlastRadius;
```

**Step 1.1 — Write the failing test first**

```ts
// server/src/modules/overview/blast-radius/project.test.ts
import { describe, it, expect } from 'vitest';
import { projectBlastRadius } from './project.js';
import type { BlastResult } from '../../repo-intel/types.js';

describe('projectBlastRadius', () => {
  it('folds factsByFile endpoints/crons into per-symbol nodes via caller files', () => {
    const input: BlastResult = {
      changedSymbols: [
        { name: 'rateLimit', file: 'src/lib/rate.ts', kind: 'function' },
        { name: 'parseToken', file: 'src/lib/auth.ts', kind: 'function' },
      ],
      callers: [
        { file: 'src/routes/api.ts',   symbol: 'apiHandler',   viaSymbol: 'rateLimit',   line: 12, rank: 0 },
        { file: 'src/routes/admin.ts', symbol: 'adminHandler', viaSymbol: 'rateLimit',   line: 33, rank: 0 },
        { file: 'src/routes/api.ts',   symbol: 'apiHandler',   viaSymbol: 'parseToken',  line: 18, rank: 0 },
        { file: 'src/jobs/cleanup.ts', symbol: 'cleanupJob',   viaSymbol: 'parseToken',  line:  4, rank: 0 },
      ],
      impactedEndpoints: ['GET /api/users', 'POST /admin/users'],
      factsByFile: {
        'src/routes/api.ts':   { endpoints: ['GET /api/users'], crons: [] },
        'src/routes/admin.ts': { endpoints: ['POST /admin/users'], crons: [] },
        'src/jobs/cleanup.ts': { endpoints: [], crons: ['0 3 * * * cleanup'] },
      },
    };

    const out = projectBlastRadius(input);

    expect(out.changed_symbols).toEqual([
      { name: 'rateLimit',  file: 'src/lib/rate.ts', kind: 'function' },
      { name: 'parseToken', file: 'src/lib/auth.ts', kind: 'function' },
    ]);
    expect(out.downstream).toHaveLength(2);

    const rate = out.downstream.find((d) => d.symbol === 'rateLimit')!;
    expect(rate.callers).toEqual([
      { name: 'apiHandler',   file: 'src/routes/api.ts',   line: 12 },
      { name: 'adminHandler', file: 'src/routes/admin.ts', line: 33 },
    ]);
    expect(rate.endpoints_affected.sort()).toEqual(['GET /api/users', 'POST /admin/users']);
    expect(rate.crons_affected).toEqual([]);

    const tok = out.downstream.find((d) => d.symbol === 'parseToken')!;
    expect(tok.callers).toHaveLength(2);
    expect(tok.endpoints_affected).toEqual(['GET /api/users']);
    expect(tok.crons_affected).toEqual(['0 3 * * * cleanup']);
  });

  it('returns an empty BlastRadius when degraded with no data', () => {
    const out = projectBlastRadius({
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: true,
      reason: 'no_data',
    });
    expect(out.changed_symbols).toEqual([]);
    expect(out.downstream).toEqual([]);
    expect(out.summary).toBe('');
  });

  it('survives missing factsByFile (degraded ripgrep path) — endpoints/crons just empty', () => {
    const out = projectBlastRadius({
      changedSymbols: [{ name: 'foo', file: 'a.ts', kind: 'function' }],
      callers: [{ file: 'b.ts', symbol: 'bar', viaSymbol: 'foo', line: 1, rank: 0 }],
      impactedEndpoints: [],
      // factsByFile intentionally absent
    });
    expect(out.downstream[0]?.endpoints_affected).toEqual([]);
    expect(out.downstream[0]?.crons_affected).toEqual([]);
  });

  it('deduplicates endpoints when two callers live in the same file', () => {
    const out = projectBlastRadius({
      changedSymbols: [{ name: 'x', file: 'x.ts', kind: 'function' }],
      callers: [
        { file: 'c.ts', symbol: 'one', viaSymbol: 'x', line: 1, rank: 0 },
        { file: 'c.ts', symbol: 'two', viaSymbol: 'x', line: 9, rank: 0 },
      ],
      impactedEndpoints: ['GET /c'],
      factsByFile: { 'c.ts': { endpoints: ['GET /c'], crons: [] } },
    });
    expect(out.downstream[0]?.endpoints_affected).toEqual(['GET /c']);
  });
});
```

Run it — expect a fail (file does not exist yet):

```bash
cd server && pnpm exec vitest run src/modules/overview/blast-radius/project.test.ts
```

Expected: `Error: Failed to load url ./project.js` (or `Cannot find module`).

**Step 1.2 — Implement `project.ts`** (this is THE projection. Verbatim, exactly as it must ship.)

```ts
// server/src/modules/overview/blast-radius/project.ts
import type { BlastResult } from '../../repo-intel/types.js';
import type { BlastRadius, DownstreamImpact, BlastCaller } from '@devdigest/shared';

/**
 * Project the flat `BlastResult` from repo-intel into the per-symbol tree
 * shape the UI renders. The fold is:
 *
 *   for each changed symbol S:
 *     callers(S)        = BlastResult.callers where viaSymbol === S.name
 *     callerFiles(S)    = unique files of callers(S)
 *     endpoints(S)      = union over callerFiles(S) of factsByFile[file].endpoints
 *     crons(S)          = union over callerFiles(S) of factsByFile[file].crons
 *
 * Pure: no I/O, no container. Same input → same output.
 * Degraded passthrough: the caller (service.ts) decides the response envelope;
 * here we just produce an empty-but-valid `BlastRadius` when input is empty.
 */
export function projectBlastRadius(input: BlastResult): BlastRadius {
  const facts = input.factsByFile ?? {};

  const downstream: DownstreamImpact[] = input.changedSymbols.map((sym) => {
    const callerRows = input.callers.filter((c) => c.viaSymbol === sym.name);

    const callers: BlastCaller[] = callerRows.map((c) => ({
      name: c.symbol,
      file: c.file,
      line: c.line,
    }));

    const endpoints = new Set<string>();
    const crons = new Set<string>();
    const seenFiles = new Set<string>();
    for (const c of callerRows) {
      if (seenFiles.has(c.file)) continue;
      seenFiles.add(c.file);
      const f = facts[c.file];
      if (!f) continue;
      for (const e of f.endpoints) endpoints.add(e);
      for (const k of f.crons) crons.add(k);
    }

    return {
      symbol: sym.name,
      callers,
      endpoints_affected: Array.from(endpoints),
      crons_affected: Array.from(crons),
    };
  });

  return {
    changed_symbols: input.changedSymbols.map((s) => ({
      name: s.name,
      file: s.file,
      kind: s.kind,
    })),
    downstream,
    summary: '', // server-side LLM summary is v2; UI computes a local one if needed
  };
}
```

Run the test again:

```bash
cd server && pnpm exec vitest run src/modules/overview/blast-radius/project.test.ts
```

Expected: all four tests pass.

**Step 1.3 — Commit**

```bash
cd server && pnpm typecheck
git add server/src/modules/overview/blast-radius/project.ts \
        server/src/modules/overview/blast-radius/project.test.ts
git commit -m 'Add pure BlastResult→BlastRadius projection for PR Overview Slice C'
```

---

### Task 2 — Overview service: load PR files, call repoIntel, project

Thin orchestrator that the route delegates to. Loads `pr_files` for the PR, calls `container.repoIntel.getBlastRadius`, projects, and returns a discriminated envelope.

**Files**

- Create: `server/src/modules/overview/service.ts`
- (No new test file — the integration test in Task 4 covers the route+service together; the projection is already unit-tested.)

**Interfaces**

```ts
import type { Container } from '../../platform/container.js';
import type { BlastRadius } from '@devdigest/shared';
import type { DegradedReason } from '../repo-intel/types.js';

export type BlastRadiusEnvelope =
  | { status: 'ready'; data: BlastRadius; headSha: string | null }
  | { status: 'degraded'; reason: DegradedReason | 'unknown' };

export class OverviewService {
  constructor(private container: Container);
  getBlastRadius(workspaceId: string, prId: string): Promise<BlastRadiusEnvelope>;
}
```

**Step 2.1 — Sketch the file**

```ts
// server/src/modules/overview/service.ts
import { and, eq } from 'drizzle-orm';
import type { Container } from '../../platform/container.js';
import type { BlastRadius } from '@devdigest/shared';
import * as t from '../../db/schema.js';
import { NotFoundError } from '../../platform/errors.js';
import type { DegradedReason } from '../repo-intel/types.js';
import { projectBlastRadius } from './blast-radius/project.js';

export type BlastRadiusEnvelope =
  | { status: 'ready'; data: BlastRadius; headSha: string | null }
  | { status: 'degraded'; reason: DegradedReason | 'unknown' };

export class OverviewService {
  constructor(private container: Container) {}

  /**
   * Loads PR + its files, calls repoIntel.getBlastRadius, projects.
   * Returns a `degraded` envelope when repo-intel reports degraded — the UI
   * shows a reindex CTA instead of a misleading "0 callers" tree.
   */
  async getBlastRadius(workspaceId: string, prId: string): Promise<BlastRadiusEnvelope> {
    const [pr] = await this.container.db
      .select({ id: t.pullRequests.id, repoId: t.pullRequests.repoId, headSha: t.pullRequests.headSha })
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    if (!pr) throw new NotFoundError('Pull request not found');

    const files = await this.container.db
      .select({ path: t.prFiles.path })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, pr.id));
    const changedFiles = files.map((f) => f.path);

    const result = await this.container.repoIntel.getBlastRadius(pr.repoId, changedFiles);

    if (result.degraded) {
      return { status: 'degraded', reason: result.reason ?? 'unknown' };
    }

    return { status: 'ready', data: projectBlastRadius(result), headSha: pr.headSha ?? null };
  }
}
```

**Step 2.2 — Verify typecheck**

```bash
cd server && pnpm typecheck
```

Expected: no errors (imports resolve; `BlastRadius` is re-exported from `@devdigest/shared`).

**Step 2.3 — Commit**

```bash
git add server/src/modules/overview/service.ts
git commit -m 'Add OverviewService.getBlastRadius — loads pr_files, calls repo-intel, projects'
```

---

### Task 3 — Route: `GET /pulls/:id/overview/blast-radius`

Mounts the `overview` Fastify plugin, registers the route, and wires `service.getBlastRadius`. Reuses the `IdParams` schema and `getContext` tenancy guard from the pulls module.

**Files**

- Create: `server/src/modules/overview/routes.ts`
- Modify: `server/src/modules/index.ts` (register the plugin)

**Interfaces**

```ts
// HTTP
GET /pulls/:id/overview/blast-radius
  params: { id: uuid }   // PR id (matches existing /pulls/:id pattern)
  200:    BlastRadiusEnvelope
  404:    NotFoundError → { code: 'not_found', message: 'Pull request not found' }
```

Note: the spec writes `/api/pulls/:prId/overview/blast-radius` — the `/api` prefix is mounted by `app.ts`, the Fastify plugin sees `/pulls/:id/...`. The `:id` name matches `IdParams` and the existing `/pulls/:id` routes; the spec's `:prId` is the same thing.

**Step 3.1 — Write the route**

```ts
// server/src/modules/overview/routes.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { OverviewService, type BlastRadiusEnvelope } from './service.js';

/**
 * PR Overview module — currently exposes the Blast Radius endpoint (Slice C).
 * Slices A/B/D (Brief, Prior PRs, Intent) will register additional routes here.
 */
export default async function overviewRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new OverviewService(container);

  app.get(
    '/pulls/:id/overview/blast-radius',
    { schema: { params: IdParams } },
    async (req): Promise<BlastRadiusEnvelope> => {
      const { workspaceId } = await getContext(container, req);
      return service.getBlastRadius(workspaceId, req.params.id);
    },
  );
}
```

**Step 3.2 — Register in the module index**

Edit `server/src/modules/index.ts`:

```ts
// add the import alongside the others
import overview from './overview/routes.js';

// add to the exported object
export const modules: Record<string, FastifyPluginAsync> = {
  settings,
  skills,
  repos,
  pulls,
  polling,
  workspace,
  agents,
  reviews,
  repoIntel,
  conventions,
  overview,
};
```

**Step 3.3 — Boot smoke**

```bash
cd server && pnpm typecheck && pnpm build
```

Expected: no errors. The route is registered behind the existing `/api` prefix.

**Step 3.4 — Commit**

```bash
git add server/src/modules/overview/routes.ts server/src/modules/index.ts
git commit -m 'Register overview module with GET /pulls/:id/overview/blast-radius'
```

---

### Task 4 — Integration test: route end-to-end (mocked repo-intel)

Use the existing `test/helpers/pg.ts` integration harness to seed a workspace + repo + PR + `pr_files`, then assert the route returns the expected envelope for both the ready and degraded paths. `container.repoIntel.getBlastRadius` is stubbed because seeding a real index is out of scope for this slice (and the projection is already covered by unit tests in Task 1).

**Files**

- Create: `server/src/modules/overview/routes.it.test.ts`

**Step 4.1 — Write the failing test**

```ts
// server/src/modules/overview/routes.it.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildAppForTest, type TestApp } from '../../../test/helpers/pg.js';
import * as t from '../../db/schema.js';
import type { BlastResult } from '../repo-intel/types.js';

describe('GET /pulls/:id/overview/blast-radius', () => {
  let app: TestApp;
  let prId: string;
  let repoId: string;

  beforeAll(async () => {
    app = await buildAppForTest();
    // Seed: workspace already exists (default), insert repo + PR + pr_files.
    const [repo] = await app.container.db
      .insert(t.repos)
      .values({
        workspaceId: app.workspaceId,
        provider: 'github',
        owner: 'acme',
        name: 'svc',
        defaultBranch: 'main',
      })
      .returning();
    repoId = repo.id;

    const [pr] = await app.container.db
      .insert(t.pullRequests)
      .values({
        workspaceId: app.workspaceId,
        repoId,
        number: 42,
        title: 'Tighten rate limiter',
        author: 'me',
        branch: 'feat/rate',
        base: 'main',
        headSha: 'abc123',
        additions: 10,
        deletions: 2,
        filesCount: 1,
        status: 'open',
      })
      .returning();
    prId = pr.id;

    await app.container.db.insert(t.prFiles).values([
      { prId, path: 'src/lib/rate.ts', additions: 10, deletions: 2, patch: null },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('projects a non-degraded BlastResult into the ready envelope', async () => {
    const fake: BlastResult = {
      changedSymbols: [{ name: 'rateLimit', file: 'src/lib/rate.ts', kind: 'function' }],
      callers: [
        { file: 'src/routes/api.ts', symbol: 'apiHandler', viaSymbol: 'rateLimit', line: 12, rank: 0 },
      ],
      impactedEndpoints: ['GET /api/users'],
      factsByFile: { 'src/routes/api.ts': { endpoints: ['GET /api/users'], crons: [] } },
    };
    vi.spyOn(app.container.repoIntel, 'getBlastRadius').mockResolvedValueOnce(fake);

    const res = await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/blast-radius` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.headSha).toBe('abc123');
    expect(body.data.changed_symbols).toEqual([
      { name: 'rateLimit', file: 'src/lib/rate.ts', kind: 'function' },
    ]);
    expect(body.data.downstream[0].callers).toEqual([
      { name: 'apiHandler', file: 'src/routes/api.ts', line: 12 },
    ]);
    expect(body.data.downstream[0].endpoints_affected).toEqual(['GET /api/users']);
  });

  it('returns a degraded envelope when repo-intel is degraded', async () => {
    vi.spyOn(app.container.repoIntel, 'getBlastRadius').mockResolvedValueOnce({
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: true,
      reason: 'no_data',
    });

    const res = await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/blast-radius` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'degraded', reason: 'no_data' });
  });

  it('404s on an unknown PR id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/pulls/00000000-0000-0000-0000-000000000000/overview/blast-radius`,
    });
    expect(res.statusCode).toBe(404);
  });
});
```

> **Adapter note:** if `test/helpers/pg.ts` does not yet expose `buildAppForTest`/`TestApp` exactly as imported above, mirror the pattern used by an existing integration test (e.g. `server/src/modules/reviews/<something>.it.test.ts`) and adjust the imports to match. The seed shape is the same; only the harness entry point may differ.

Run it:

```bash
cd server && pnpm exec vitest run src/modules/overview/routes.it.test.ts
```

Expected: all three tests pass (the route + service + projection are already wired by Tasks 1–3).

**Step 4.2 — Commit**

```bash
git add server/src/modules/overview/routes.it.test.ts
git commit -m 'Cover GET /pulls/:id/overview/blast-radius with ready/degraded/404 integration tests'
```

---

### Task 5 — Client hook: `useOverviewBlastRadius`

A typed React Query hook. The envelope is mirrored client-side because `@devdigest/shared` already exposes the `BlastRadius` Zod (via `client/src/vendor/shared/contracts/brief.ts`).

**Files**

- Create: `client/src/lib/hooks/overview.ts`

**Interfaces**

```ts
import type { BlastRadius } from '@devdigest/shared';

export type BlastRadiusEnvelope =
  | { status: 'ready'; data: BlastRadius; headSha: string | null }
  | { status: 'degraded'; reason: string }
  | { status: 'error'; message: string };

export function useOverviewBlastRadius(prId: string | null | undefined):
  UseQueryResult<BlastRadiusEnvelope>;
```

**Step 5.1 — Write the hook**

```ts
// client/src/lib/hooks/overview.ts
/* hooks/overview.ts — React Query hooks for the PR Overview tab. Slice C
   ships useOverviewBlastRadius; Slices A/B/D add Brief / Prior PRs / Intent. */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { BlastRadius } from "@devdigest/shared";
import { api } from "../api";

export type BlastRadiusEnvelope =
  | { status: "ready"; data: BlastRadius; headSha: string | null }
  | { status: "degraded"; reason: string }
  | { status: "error"; message: string };

/** GET /pulls/:id/overview/blast-radius — synchronous, no cache server-side. */
export function useOverviewBlastRadius(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["overview-blast-radius", prId],
    queryFn: () => api.get<BlastRadiusEnvelope>(`/pulls/${prId}/overview/blast-radius`),
    enabled: !!prId,
    staleTime: 30_000,
  });
}
```

**Step 5.2 — Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: no errors.

**Step 5.3 — Commit**

```bash
git add client/src/lib/hooks/overview.ts
git commit -m 'Add useOverviewBlastRadius client hook'
```

---

### Task 6 — `BlastRadiusCard` component (TDD)

The visible card. Counts row at top, tree of `changed_symbols → callers → endpoint/cron chips` below. Disabled Tree↔Graph toggle (v2 promise). When the envelope is `degraded`, replace the tree with a CTA card pointing the user at reindex.

**Files**

- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/BlastRadiusCard/BlastRadiusCard.tsx`
- Create: `…/BlastRadiusCard.test.tsx`
- Create: `…/styles.ts`
- Create: `…/index.ts`

**Interfaces**

```ts
export interface BlastRadiusCardProps {
  prId: string;
}
export function BlastRadiusCard(props: BlastRadiusCardProps): JSX.Element;
```

**Step 6.1 — Write the failing tests**

```tsx
// .../BlastRadiusCard.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlastRadiusCard } from "./BlastRadiusCard";
import * as hooks from "../../../../../../../../lib/hooks/overview";

afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("BlastRadiusCard", () => {
  it("renders counts and an expandable symbol tree on ready", () => {
    vi.spyOn(hooks, "useOverviewBlastRadius").mockReturnValue({
      data: {
        status: "ready",
        headSha: "abc123",
        data: {
          changed_symbols: [{ name: "rateLimit", file: "src/lib/rate.ts", kind: "function" }],
          downstream: [
            {
              symbol: "rateLimit",
              callers: [{ name: "apiHandler", file: "src/routes/api.ts", line: 12 }],
              endpoints_affected: ["GET /api/users"],
              crons_affected: [],
            },
          ],
          summary: "",
        },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof hooks.useOverviewBlastRadius>);

    wrap(<BlastRadiusCard prId="pr-1" />);
    // Counts row
    expect(screen.getByText(/1 symbol/i)).toBeInTheDocument();
    expect(screen.getByText(/1 caller/i)).toBeInTheDocument();
    expect(screen.getByText(/1 endpoint/i)).toBeInTheDocument();
    // Symbol header visible; caller hidden until expand
    expect(screen.getByText("rateLimit")).toBeInTheDocument();
    expect(screen.queryByText("apiHandler")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /rateLimit/ }));
    expect(screen.getByText("apiHandler")).toBeInTheDocument();
    expect(screen.getByText("GET /api/users")).toBeInTheDocument();
  });

  it("shows the reindex CTA on degraded — never a misleading zero tree", () => {
    vi.spyOn(hooks, "useOverviewBlastRadius").mockReturnValue({
      data: { status: "degraded", reason: "no_data" },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof hooks.useOverviewBlastRadius>);

    wrap(<BlastRadiusCard prId="pr-1" />);
    expect(screen.getByText(/Indexing pending/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /reindex/i })).toBeInTheDocument();
    expect(screen.queryByText(/symbol/i)).not.toBeInTheDocument();
  });

  it("renders the Graph toggle disabled with a v2 tooltip", () => {
    vi.spyOn(hooks, "useOverviewBlastRadius").mockReturnValue({
      data: { status: "ready", headSha: null, data: { changed_symbols: [], downstream: [], summary: "" } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof hooks.useOverviewBlastRadius>);

    wrap(<BlastRadiusCard prId="pr-1" />);
    const graphBtn = screen.getByRole("button", { name: /graph/i });
    expect(graphBtn).toBeDisabled();
    expect(graphBtn).toHaveAttribute("title", expect.stringMatching(/v2/i));
  });
});
```

Run it (expect fail, file does not exist):

```bash
cd client && pnpm exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/BlastRadiusCard/BlastRadiusCard.test.tsx
```

**Step 6.2 — Implement the card**

```tsx
// .../BlastRadiusCard.tsx
"use client";

import React, { useMemo, useState } from "react";
import type { BlastRadius } from "@devdigest/shared";
import { useOverviewBlastRadius } from "../../../../../../../../lib/hooks/overview";
import { s } from "./styles";

/**
 * Blast Radius card (PR Overview, Slice C).
 * Counts derived on the client from BlastRadius — keeps the wire format = shared Zod.
 * Tree-only in v1; Graph view is v2 (toggle rendered disabled with a tooltip).
 * Degraded path renders a reindex CTA — never a misleading "0 callers" tree.
 */
export interface BlastRadiusCardProps {
  prId: string;
}

export function BlastRadiusCard({ prId }: BlastRadiusCardProps) {
  const q = useOverviewBlastRadius(prId);

  if (q.isLoading) return <div style={s.card}>Loading blast radius…</div>;
  if (q.isError || !q.data) {
    return <div style={s.card}>Could not load blast radius.</div>;
  }
  const env = q.data;

  if (env.status === "degraded") {
    return (
      <div style={s.card} role="region" aria-label="Blast radius">
        <div style={s.header}>
          <strong>Blast Radius</strong>
          <GraphToggleDisabled />
        </div>
        <p style={s.degradedMsg}>
          Indexing pending — the code index isn't ready for this repo yet ({env.reason}).
          Kick a reindex to populate callers and endpoints.
        </p>
        <a href="#reindex" style={s.cta}>Reindex repo</a>
      </div>
    );
  }
  if (env.status === "error") {
    return <div style={s.card}>Error: {env.message}</div>;
  }

  return <BlastRadiusReady data={env.data} />;
}

function BlastRadiusReady({ data }: { data: BlastRadius }) {
  const counts = useMemo(() => {
    const callers = new Set<string>();
    const endpoints = new Set<string>();
    const crons = new Set<string>();
    for (const d of data.downstream) {
      for (const c of d.callers) callers.add(`${c.file}|${c.name}`);
      for (const e of d.endpoints_affected) endpoints.add(e);
      for (const k of d.crons_affected) crons.add(k);
    }
    return {
      symbols: data.changed_symbols.length,
      callers: callers.size,
      endpoints: endpoints.size,
      crons: crons.size,
    };
  }, [data]);

  return (
    <div style={s.card} role="region" aria-label="Blast radius">
      <div style={s.header}>
        <strong>Blast Radius</strong>
        <GraphToggleDisabled />
      </div>
      <div style={s.counts}>
        <span>{counts.symbols} symbol{counts.symbols === 1 ? "" : "s"}</span>
        <span>{counts.callers} caller{counts.callers === 1 ? "" : "s"}</span>
        <span>{counts.endpoints} endpoint{counts.endpoints === 1 ? "" : "s"}</span>
        <span>{counts.crons} cron{counts.crons === 1 ? "" : "s"}</span>
      </div>
      <ul style={s.tree}>
        {data.downstream.map((node) => (
          <SymbolNode key={node.symbol} node={node} />
        ))}
      </ul>
    </div>
  );
}

function SymbolNode({ node }: { node: BlastRadius["downstream"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li style={s.node}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={s.symbolBtn}>
        {open ? "▾" : "▸"} <code>{node.symbol}</code>
        <span style={s.muted}>
          ({node.callers.length} caller{node.callers.length === 1 ? "" : "s"})
        </span>
      </button>
      {open && (
        <ul style={s.children}>
          {node.callers.map((c) => (
            <li key={`${c.file}:${c.line}:${c.name}`} style={s.caller}>
              <code>{c.name}</code> <span style={s.muted}>· {c.file}:{c.line}</span>
            </li>
          ))}
          {node.endpoints_affected.map((e) => (
            <li key={`ep-${e}`} style={s.chipEndpoint}>{e}</li>
          ))}
          {node.crons_affected.map((k) => (
            <li key={`cr-${k}`} style={s.chipCron}>{k}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function GraphToggleDisabled() {
  return (
    <button type="button" disabled title="Graph view in v2" style={s.graphToggle}>
      Graph
    </button>
  );
}
```

```ts
// .../styles.ts
import type { CSSProperties } from "react";
export const s = {
  card: { border: "1px solid var(--border)", borderRadius: 8, padding: 16, background: "var(--bg-elevated)" } satisfies CSSProperties,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } satisfies CSSProperties,
  counts: { display: "flex", gap: 12, color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 } satisfies CSSProperties,
  tree: { listStyle: "none", padding: 0, margin: 0 } satisfies CSSProperties,
  node: { marginBottom: 6 } satisfies CSSProperties,
  symbolBtn: { background: "none", border: 0, cursor: "pointer", color: "var(--text)", padding: 0, fontSize: 14 } satisfies CSSProperties,
  muted: { color: "var(--text-secondary)", marginLeft: 6 } satisfies CSSProperties,
  children: { listStyle: "none", paddingLeft: 18, marginTop: 4 } satisfies CSSProperties,
  caller: { fontFamily: "ui-monospace, monospace", fontSize: 13, color: "var(--text)" } satisfies CSSProperties,
  chipEndpoint: { display: "inline-block", padding: "1px 6px", margin: "2px 4px 0 0", borderRadius: 4, background: "var(--accent-subtle)", fontSize: 12 } satisfies CSSProperties,
  chipCron: { display: "inline-block", padding: "1px 6px", margin: "2px 4px 0 0", borderRadius: 4, background: "var(--warning-subtle)", fontSize: 12 } satisfies CSSProperties,
  degradedMsg: { color: "var(--text-secondary)", fontSize: 13, margin: "8px 0" } satisfies CSSProperties,
  cta: { color: "var(--accent)", fontSize: 13 } satisfies CSSProperties,
  graphToggle: { fontSize: 12, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-secondary)", cursor: "not-allowed" } satisfies CSSProperties,
} as const;
```

```ts
// .../index.ts
export { BlastRadiusCard } from "./BlastRadiusCard";
```

Run the tests again:

```bash
cd client && pnpm exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/BlastRadiusCard/
```

Expected: all three tests pass.

**Step 6.3 — Commit**

```bash
git add 'client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/BlastRadiusCard/'
git commit -m 'Add BlastRadiusCard — counts row, symbol tree, degraded CTA, disabled Graph toggle'
```

---

### Task 7 — Wire `BlastRadiusCard` into `OverviewTab`

The page already passes `prBody` to `OverviewTab`; now it also passes `prId`. The tab mounts the card above the description block.

**Files**

- Modify: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`

**Step 7.1 — Update `OverviewTab.tsx`**

```tsx
"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { BlastRadiusCard } from "./_components/BlastRadiusCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  prBody: string | null | undefined;
}

export function OverviewTab({ prId, prBody }: OverviewTabProps) {
  return (
    <>
      {prId && <BlastRadiusCard prId={prId} />}
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

**Step 7.2 — Update `page.tsx`**

Find the existing `<OverviewTab prBody={pr?.body} />` (or equivalent) in `page.tsx` and replace with:

```tsx
<OverviewTab prId={prId} prBody={pr?.body} />
```

**Step 7.3 — Typecheck + smoke**

```bash
cd client && pnpm typecheck && pnpm exec vitest run
```

Expected: typecheck clean; existing test suites still pass; new card tests still pass.

**Step 7.4 — Commit**

```bash
git add 'client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx' \
        'client/src/app/repos/[repoId]/pulls/[number]/page.tsx'
git commit -m 'Mount BlastRadiusCard in OverviewTab; pass prId through page'
```

---

## Self-review checklist

Before claiming Slice C ready:

- [ ] `pnpm typecheck` clean in `server/` and `client/`.
- [ ] `pnpm test` passes in `server/` (unit + new integration test).
- [ ] `pnpm test` passes in `client/` (new RTL tests + existing suite).
- [ ] `pnpm exec vitest run .it.test` runs the integration suite (needs Docker Postgres).
- [ ] Spec §5.3 contract honored: `status: 'ready' | 'degraded' | 'error'` envelope; `BlastRadius` matches the shared Zod (`changed_symbols`, `downstream`, `summary`); no cache row introduced.
- [ ] Spec §10 honored: degraded path renders a clear CTA, not a misleading zero tree.
- [ ] Onion: only `service.ts` touches the container; `project.ts` is pure; route delegates.
- [ ] No raw `fetch` in client; no raw `throw new Error()` in routes.
- [ ] No DB migration added; no edits to `pr_brief` / `pr_intent`.
- [ ] No new dependencies added.
- [ ] Tree-only view; Graph toggle disabled with a "v2" tooltip.
- [ ] `BlastRadius` Zod is reused — not re-declared client-side.
- [ ] `/pr-self-review` run for `client/` + `server/` diff. MUST findings addressed; SHOULD findings noted in PR description.
- [ ] Commits are small, logical, and English; no `wip`, no `fix`, no `update`.

---

## Notes for follow-up slices (out of scope here)

- Slice A (Brief): server aggregator + `PrBriefCard`. Reuses the new `overview` module; only adds a `brief/` sibling to `blast-radius/`.
- Slice B (Prior PRs): single SQL query + endpoint. Trivial once the module exists.
- Slice D (Intent): largest — migration, LLM extractor, SSE. Will introduce the `pr_intent` schema extension; do NOT extend it earlier.
- LLM classification of callers (`kind: internal | test | config`) is a forward-compatible add to the existing tree (`BlastCaller` gains an optional `kind`). No breaking change required.
