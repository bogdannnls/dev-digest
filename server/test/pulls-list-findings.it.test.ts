/**
 * Integration test: GET /repos/:id/pulls — per-severity findings counts.
 *
 * Verifies that the list endpoint returns severity-bucketed finding counts
 * (CRITICAL / WARNING / SUGGESTION) drawn from the LATEST review per PR.
 * Dismissed findings are excluded; accepted findings still count.
 *
 * Gated on Docker (Testcontainers Postgres), matching the project pattern.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitHubClient, MockGitClient } from '../src/adapters/mocks.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('GET /repos/:id/pulls — findings counts', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;
  let prAId: string; // PR with 2 CRITICAL + 1 WARNING
  let prBId: string; // PR with 0 findings

  beforeAll(async () => {
    pg = await startPg();
    const cfg = loadConfig({ DATABASE_URL: pg.url, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    // Seed creates the default workspace / user / settings required by the auth middleware.
    await seed(pg.handle.db);
    // Grab the seeded workspace id so we can insert PRs in the correct tenant.
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await pg.stop();
  });

  beforeEach(async () => {
    // Insert a fresh repo + two PRs per test so assertions are deterministic
    // regardless of what the seed or prior tests left behind.
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: `findings-test-${Date.now()}`, fullName: `acme/findings-${Date.now()}` })
      .returning();
    repoId = repo!.id;

    const [prA] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 1,
        title: 'PR A — with findings',
        author: 'alice',
        branch: 'feat/a',
        base: 'main',
        headSha: 'aaa',
        additions: 10,
        deletions: 2,
        filesCount: 1,
        status: 'open',
      })
      .returning();
    prAId = prA!.id;

    const [prB] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 2,
        title: 'PR B — no findings',
        author: 'bob',
        branch: 'feat/b',
        base: 'main',
        headSha: 'bbb',
        additions: 5,
        deletions: 0,
        filesCount: 1,
        status: 'open',
      })
      .returning();
    prBId = prB!.id;

    // One review per PR.
    const [reviewA] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: prAId, kind: 'review', score: 70, model: 'test' })
      .returning();

    // 2 CRITICAL + 1 WARNING on PR A (all with dismissedAt IS NULL).
    await pg.handle.db.insert(t.findings).values([
      {
        reviewId: reviewA!.id,
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded secret',
        rationale: 'A secret is committed.',
        confidence: 0.99,
        kind: 'finding',
      },
      {
        reviewId: reviewA!.id,
        file: 'src/b.ts',
        startLine: 5,
        endLine: 5,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Another secret',
        rationale: 'Another secret is committed.',
        confidence: 0.95,
        kind: 'finding',
      },
      {
        reviewId: reviewA!.id,
        file: 'src/c.ts',
        startLine: 10,
        endLine: 12,
        severity: 'WARNING',
        category: 'perf',
        title: 'N+1 query',
        rationale: 'Loop runs one query per row.',
        confidence: 0.85,
        kind: 'finding',
      },
    ]);

    // PR B intentionally gets NO review rows → all counts should be 0.
  });

  it('returns top 5 titles per severity ordered by confidence DESC', async () => {
    const cfg = loadConfig({ DATABASE_URL: pg.url, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

    // Add 7 CRITICAL findings to PR A's review with known confidence values so
    // that we can assert the top-5 are returned in confidence DESC order.
    // The beforeEach review already has 2 CRITICAL (conf 0.99, 0.95) + 1 WARNING.
    // We insert a fresh review to keep this test self-contained.
    const [reviewExtra] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: prAId, kind: 'review', score: 80, model: 'test' })
      .returning();

    // Wait 1 ms so createdAt differs and this review is NOT the latest.
    // We want the beforeEach review to remain "latest" — actually we want THIS
    // review to be latest (newest). We insert it after beforeEach, so it will be
    // newer → it IS the latest review for prAId. We seed exactly 7 CRITICAL findings.
    await pg.handle.db.insert(t.findings).values([
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 1, endLine: 1, severity: 'CRITICAL', category: 'sec', title: 'T01', rationale: 'r', confidence: 0.1, kind: 'finding' },
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 2, endLine: 2, severity: 'CRITICAL', category: 'sec', title: 'T02', rationale: 'r', confidence: 0.2, kind: 'finding' },
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 3, endLine: 3, severity: 'CRITICAL', category: 'sec', title: 'T03', rationale: 'r', confidence: 0.3, kind: 'finding' },
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 4, endLine: 4, severity: 'CRITICAL', category: 'sec', title: 'T04', rationale: 'r', confidence: 0.4, kind: 'finding' },
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 5, endLine: 5, severity: 'CRITICAL', category: 'sec', title: 'T05', rationale: 'r', confidence: 0.5, kind: 'finding' },
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 6, endLine: 6, severity: 'CRITICAL', category: 'sec', title: 'T06', rationale: 'r', confidence: 0.6, kind: 'finding' },
      { reviewId: reviewExtra!.id, file: 'f.ts', startLine: 7, endLine: 7, severity: 'CRITICAL', category: 'sec', title: 'T07', rationale: 'r', confidence: 0.7, kind: 'finding' },
    ]);

    const app = await buildApp({
      config: cfg,
      db: pg.handle.db,
      overrides: {
        github: new MockGitHubClient({ pulls: [] }),
        git: new MockGitClient(),
      },
    });

    try {
      const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ id: string; findings: any }>;
      const a = body.find((p) => p.id === prAId)!;
      expect(a, 'PR A should be in the list').toBeDefined();
      expect(a.findings.CRITICAL.titles).toHaveLength(5);
      expect(a.findings.CRITICAL.titles.map((t: any) => t.title)).toEqual([
        'T07', 'T06', 'T05', 'T04', 'T03', // confidence DESC (0.7 → 0.3)
      ]);
    } finally {
      await app.close();
    }
  });

  it('returns severity-bucketed counts per PR from the latest review', async () => {
    const cfg = loadConfig({ DATABASE_URL: pg.url, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config: cfg,
      db: pg.handle.db,
      overrides: {
        github: new MockGitHubClient({ pulls: [] }),
        git: new MockGitClient(),
      },
    });

    try {
      const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ id: string; findings: any }>;

      const a = body.find((p) => p.id === prAId);
      const b = body.find((p) => p.id === prBId);

      expect(a, 'PR A should be in the list').toBeDefined();
      expect(b, 'PR B should be in the list').toBeDefined();

      expect(a!.findings.CRITICAL.count).toBe(2);
      expect(a!.findings.WARNING.count).toBe(1);
      expect(a!.findings.SUGGESTION.count).toBe(0);

      expect(b!.findings.CRITICAL.count).toBe(0);
      expect(b!.findings.WARNING.count).toBe(0);
      expect(b!.findings.SUGGESTION.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('excluded dismissed findings from counts', async () => {
    const cfg = loadConfig({ DATABASE_URL: pg.url, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

    // Add a dismissed CRITICAL finding to PR B's review — it should NOT count.
    const [reviewB] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: prBId, kind: 'review', score: 90, model: 'test' })
      .returning();
    await pg.handle.db.insert(t.findings).values({
      reviewId: reviewB!.id,
      file: 'src/d.ts',
      startLine: 1,
      endLine: 1,
      severity: 'CRITICAL',
      category: 'security',
      title: 'Dismissed finding',
      rationale: 'This was wrong.',
      confidence: 0.5,
      kind: 'finding',
      dismissedAt: new Date(), // dismissed → must not count
    });

    const app = await buildApp({
      config: cfg,
      db: pg.handle.db,
      overrides: {
        github: new MockGitHubClient({ pulls: [] }),
        git: new MockGitClient(),
      },
    });

    try {
      const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ id: string; findings: any }>;
      const b = body.find((p) => p.id === prBId);
      expect(b!.findings.CRITICAL.count).toBe(0);
    } finally {
      await app.close();
    }
  });
});
