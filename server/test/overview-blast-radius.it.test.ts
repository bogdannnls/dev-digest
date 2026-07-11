/**
 * Integration test: GET /pulls/:id/overview/blast-radius.
 *
 * Verifies the route's wiring end-to-end against a real Postgres:
 *   getPull() (workspace-scoped) → getChangedFilePaths() (prFiles) →
 *   container.repoIntel.getBlastRadius(repoId, files) → projectBlastRadius().
 *
 * `repoIntel` is a facade injected via `ContainerOverrides.repoIntel` — its
 * `getBlastRadius` is stubbed with `vi.fn()` per-test so we control the
 * flat `BlastResult` shape and assert the route correctly regroups it into
 * the wire `BlastRadius` envelope (grouped by symbol, per-symbol callers +
 * endpoints_affected). AC1: this pure-read path never calls an LLM — the
 * projection hardcodes `summary: ''`, and no `overrides.llm` is ever
 * configured in this suite, so any accidental LLM call would surface as a
 * ConfigError (missing secrets) rather than a silent success.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { RepoIntel, BlastResult } from '../src/modules/repo-intel/types.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[overview-blast-radius] Docker not available — skipping integration tests.');
}

/**
 * Minimal RepoIntel stub. The route only ever calls `getBlastRadius`; every
 * other facade method is a bare `vi.fn()` so the object satisfies the
 * `RepoIntel` interface without pretending to implement it for real.
 */
function makeRepoIntelStub(result: BlastResult): RepoIntel {
  return {
    indexRepo: vi.fn(),
    refreshIndex: vi.fn(),
    getIndexState: vi.fn(),
    getBlastRadius: vi.fn().mockResolvedValue(result),
    getRepoMap: vi.fn(),
    getFileRank: vi.fn(),
    getSymbolsInFiles: vi.fn(),
    getCallerSignatures: vi.fn(),
    getUnresolvedReferences: vi.fn(),
    getConventionSamples: vi.fn(),
    getTopFilesByRank: vi.fn(),
    getCriticalPaths: vi.fn(),
  } as unknown as RepoIntel;
}

d('GET /pulls/:id/overview/blast-radius', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: `blast-${Date.now()}`,
        fullName: `acme/blast-${Date.now()}`,
      })
      .returning();
    repoId = repo!.id;

    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 1,
        title: 'PR for blast radius',
        author: 'alice',
        branch: 'feat/x',
        base: 'main',
        headSha: 'sha1',
        additions: 10,
        deletions: 2,
        filesCount: 2,
        status: 'open',
      })
      .returning();
    prId = pr!.id;
  });

  function makeApp(repoIntel: RepoIntel) {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        forge: { github: new MockGitHubClient() },
        repoIntel,
      },
    });
  }

  it('ready + rows: groups callers per changed symbol, threads endpoints/crons, and never runs an LLM', async () => {
    await pg.handle.db.insert(t.prFiles).values([
      { prId, path: 'src/util/helper.ts', additions: 5, deletions: 1 },
      { prId, path: 'src/util/parser.ts', additions: 3, deletions: 0 },
    ]);

    const result: BlastResult = {
      changedSymbols: [
        { file: 'src/util/helper.ts', name: 'formatDate', kind: 'function' },
        { file: 'src/util/parser.ts', name: 'parseDate', kind: 'function' },
      ],
      callers: [
        { file: 'src/routes/users.ts', symbol: 'listUsers', viaSymbol: 'formatDate', line: 12, rank: 90 },
        { file: 'src/routes/orders.ts', symbol: 'listOrders', viaSymbol: 'formatDate', line: 30, rank: 50 },
        { file: 'src/routes/users.ts', symbol: 'getUser', viaSymbol: 'parseDate', line: 40, rank: 90 },
      ],
      impactedEndpoints: ['GET /users', 'GET /orders'],
      factsByFile: {
        'src/routes/users.ts': { endpoints: ['GET /users'], crons: [] },
        'src/routes/orders.ts': { endpoints: ['GET /orders'], crons: ['nightly-orders'] },
      },
      degraded: false,
    };
    const repoIntel = makeRepoIntelStub(result);
    const app = await makeApp(repoIntel);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/blast-radius` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe('ready');
    expect(body.reason).toBeUndefined();
    expect(body.data.changed_symbols).toEqual([
      { name: 'formatDate', file: 'src/util/helper.ts', kind: 'function' },
      { name: 'parseDate', file: 'src/util/parser.ts', kind: 'function' },
    ]);
    expect(body.data.downstream).toEqual([
      {
        symbol: 'formatDate',
        callers: [
          { name: 'listUsers', file: 'src/routes/users.ts', line: 12 },
          { name: 'listOrders', file: 'src/routes/orders.ts', line: 30 },
        ],
        endpoints_affected: ['GET /users', 'GET /orders'],
        crons_affected: ['nightly-orders'],
      },
      {
        symbol: 'parseDate',
        callers: [{ name: 'getUser', file: 'src/routes/users.ts', line: 40 }],
        endpoints_affected: ['GET /users'],
        crons_affected: [],
      },
    ]);
    // AC1 — no LLM ran on this pure-read path; the projection hardcodes an empty summary.
    expect(body.data.summary).toBe('');
    await app.close();
  });

  it('degraded + rows: reason surfaces, callers/endpoints still present via the degraded global fallback', async () => {
    await pg.handle.db.insert(t.prFiles).values([
      { prId, path: 'src/util/helper.ts', additions: 5, deletions: 1 },
    ]);

    const result: BlastResult = {
      changedSymbols: [{ file: 'src/util/helper.ts', name: 'formatDate', kind: 'function' }],
      callers: [
        { file: 'src/routes/users.ts', symbol: 'listUsers', viaSymbol: 'formatDate', line: 12, rank: 0 },
        { file: 'src/routes/orders.ts', symbol: 'listOrders', viaSymbol: 'formatDate', line: 30, rank: 0 },
      ],
      impactedEndpoints: ['GET /users', 'GET /orders'],
      // No factsByFile on the degraded (ripgrep) path.
      degraded: true,
      reason: 'no_data',
    };
    const repoIntel = makeRepoIntelStub(result);
    const app = await makeApp(repoIntel);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/blast-radius` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe('degraded');
    expect(body.reason).toBe('no_data');
    expect(body.data.downstream).toEqual([
      {
        symbol: 'formatDate',
        callers: [
          { name: 'listUsers', file: 'src/routes/users.ts', line: 12 },
          { name: 'listOrders', file: 'src/routes/orders.ts', line: 30 },
        ],
        // No factsByFile → global impactedEndpoints fallback attached to the symbol with callers.
        endpoints_affected: ['GET /users', 'GET /orders'],
        crons_affected: [],
      },
    ]);
    await app.close();
  });

  it('degraded + empty: empty changed_symbols/downstream while status + reason still surface', async () => {
    const result: BlastResult = {
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: true,
      reason: 'no_data',
    };
    const repoIntel = makeRepoIntelStub(result);
    const app = await makeApp(repoIntel);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/blast-radius` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe('degraded');
    expect(body.reason).toBe('no_data');
    expect(body.data.changed_symbols).toEqual([]);
    expect(body.data.downstream).toEqual([]);
    await app.close();
  });

  it('returns 404 when the PR is not in the caller workspace', async () => {
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-ws-${Date.now()}` })
      .returning();
    const [otherRepo] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId: otherWs!.id,
        owner: 'x',
        name: 'y',
        fullName: `x/y-${Date.now()}`,
      })
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

    const repoIntel = makeRepoIntelStub({
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: false,
    });
    const app = await makeApp(repoIntel);

    const res = await app.inject({
      method: 'GET',
      url: `/pulls/${otherPr!.id}/overview/blast-radius`,
    });
    expect(res.statusCode).toBe(404);
    // 404 must short-circuit before the facade is ever consulted.
    expect(repoIntel.getBlastRadius).not.toHaveBeenCalled();
    await app.close();
  });

  it('wires the seeded prFiles paths and the pull.repoId into getBlastRadius exactly once', async () => {
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    await pg.handle.db
      .insert(t.prFiles)
      .values(paths.map((path) => ({ prId, path, additions: 1, deletions: 0 })));

    const repoIntel = makeRepoIntelStub({
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: false,
    });
    const app = await makeApp(repoIntel);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/blast-radius` });
    expect(res.statusCode).toBe(200);

    expect(repoIntel.getBlastRadius).toHaveBeenCalledTimes(1);
    const getBlastRadius = repoIntel.getBlastRadius as unknown as ReturnType<typeof vi.fn>;
    const [calledRepoId, calledFiles] = getBlastRadius.mock.calls[0] as [string, string[]];
    expect(calledRepoId).toBe(repoId);
    expect([...calledFiles].sort()).toEqual([...paths].sort());
    await app.close();
  });
});
