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
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[overview-brief] Docker not available — skipping integration tests.');
}

d('GET /pulls/:id/overview/brief', () => {
  let pg: PgFixture;
  let workspaceId: string;
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
        name: `ov-${Date.now()}`,
        fullName: `acme/ov-${Date.now()}`,
      })
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

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), forge: { github: new MockGitHubClient() } },
    });
  }

  it('returns no_runs when the PR has no reviews', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'no_runs' });
    await app.close();
  });

  it('aggregates worst verdict + score mean + blockers + cost across runs', async () => {
    // Two runs → two reviews. One request_changes (worst) + one approve.
    const [run1] = await pg.handle.db
      .insert(t.agentRuns)
      .values({
        workspaceId,
        prId,
        model: 'gpt-4o-mini',
        tokensIn: 1000,
        tokensOut: 200,
        status: 'done',
      })
      .returning();
    const [run2] = await pg.handle.db
      .insert(t.agentRuns)
      .values({
        workspaceId,
        prId,
        model: 'gpt-4o-mini',
        tokensIn: 500,
        tokensOut: 100,
        status: 'done',
      })
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
      {
        reviewId: rev1!.id,
        file: 'a.ts',
        startLine: 1,
        endLine: 1,
        severity: 'blocker',
        category: 'bug',
        title: 't1',
        rationale: 'r',
        confidence: 0.9,
      },
      {
        reviewId: rev1!.id,
        file: 'a.ts',
        startLine: 2,
        endLine: 2,
        severity: 'critical',
        category: 'bug',
        title: 't2',
        rationale: 'r',
        confidence: 0.9,
      },
      {
        reviewId: rev1!.id,
        file: 'a.ts',
        startLine: 3,
        endLine: 3,
        severity: 'warning',
        category: 'style',
        title: 't3',
        rationale: 'r',
        confidence: 0.9,
      },
      {
        reviewId: rev2!.id,
        file: 'a.ts',
        startLine: 4,
        endLine: 4,
        severity: 'suggestion',
        category: 'nit',
        title: 't4',
        rationale: 'r',
        confidence: 0.9,
      },
    ]);

    const app = await makeApp();
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
    expect(body.data.blockersCount).toBe(2); // blocker + critical
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

    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/pulls/${otherPr!.id}/overview/brief` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 422 for an invalid (non-UUID) prId', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/overview/brief' });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
