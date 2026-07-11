/**
 * Integration test: GET /pulls/:id/smart-diff.
 *
 * Verifies the route composes a `SmartDiffResponse` from a PR's persisted
 * `pr_files` rows and its LATEST 'review'-kind review's findings — mirroring
 * the "latest review per PR" consistency rule documented for
 * `computeFindingsByPr` (server/INSIGHTS.md, 2026-06-19). Dismissed findings
 * are excluded. Workspace ownership is enforced (404 for a foreign PR).
 *
 * Gated on Docker (Testcontainers Postgres), matching the project pattern.
 * No auth headers are used — LocalNoAuthProvider (the MVP auth provider)
 * resolves a fixed default workspace/user regardless of request headers, as
 * shown by every other `.it.test.ts` in this repo (e.g. `pulls-comments.it.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startPg, dockerAvailable, type PgFixture } from '../../../test/helpers/pg.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../platform/config.js';
import { seed } from '../../db/seed.js';
import * as t from '../../db/schema.js';
import type { SmartDiffResponse } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

d('GET /pulls/:id/smart-diff', () => {
  let pg: PgFixture;
  let app: FastifyInstance;
  let workspaceId: string;
  let repoId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    const { db } = pg.handle;
    // Clean PR-scoped tables between tests so each test is isolated.
    await db.delete(t.findings);
    await db.delete(t.reviews);
    await db.delete(t.prFiles);
    await db.delete(t.pullRequests);

    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    const [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: `smart-diff-repo-${Date.now()}`,
        fullName: `acme/smart-diff-repo-${Date.now()}`,
      })
      .returning();
    repoId = repo!.id;

    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 1,
        title: 'Add smart diff composer',
        author: 'alice',
        branch: 'feat/smart-diff',
        base: 'main',
        headSha: 'abc123',
        additions: 30,
        deletions: 5,
        filesCount: 3,
        status: 'open',
      })
      .returning();
    prId = pr!.id;

    // One core file, one wiring file, one boilerplate file — exercises all
    // three groups in a single PR.
    await db.insert(t.prFiles).values([
      { prId, path: 'src/service.ts', additions: 20, deletions: 3 },
      { prId, path: 'package.json', additions: 1, deletions: 0 },
      { prId, path: 'pnpm-lock.yaml', additions: 9, deletions: 2 },
    ]);

    app = await buildApp({ config: config(), db });
  });

  it('returns three groups with empty finding_lines when the PR has no reviews', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SmartDiffResponse;

    expect(body.groups).toHaveLength(3);
    for (const group of body.groups) {
      for (const file of group.files) {
        expect(file.finding_lines).toEqual([]);
      }
    }
  });

  it('uses only the latest review’s findings; older review findings are absent', async () => {
    const { db } = pg.handle;

    const [olderReview] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId, kind: 'review', score: 60, model: 'test' })
      .returning();
    await db.insert(t.findings).values({
      reviewId: olderReview!.id,
      file: 'src/service.ts',
      startLine: 99,
      endLine: 99,
      severity: 'WARNING',
      category: 'perf',
      title: 'Stale finding',
      rationale: 'From an older review; should not appear.',
      confidence: 0.5,
      kind: 'finding',
    });

    // Insert the newer review after the older one so createdAt ordering is
    // deterministic regardless of clock resolution.
    const [latestReview] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId, kind: 'review', score: 80, model: 'test' })
      .returning();
    await db.insert(t.findings).values({
      reviewId: latestReview!.id,
      file: 'src/service.ts',
      startLine: 12,
      endLine: 12,
      severity: 'CRITICAL',
      category: 'security',
      title: 'Fresh finding',
      rationale: 'From the latest review; should appear.',
      confidence: 0.9,
      kind: 'finding',
    });

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SmartDiffResponse;

    const coreGroup = body.groups.find((g) => g.role === 'core')!;
    const serviceFile = coreGroup.files.find((f) => f.path === 'src/service.ts')!;
    expect(serviceFile.finding_lines).toEqual([12]);
    expect(serviceFile.finding_lines).not.toContain(99);
  });

  it('returns 404 for a PR not owned by the requesting workspace', async () => {
    const { db } = pg.handle;
    const [otherWorkspace] = await db.insert(t.workspaces).values({ name: 'other-ws' }).returning();
    const [otherRepo] = await db
      .insert(t.repos)
      .values({
        workspaceId: otherWorkspace!.id,
        owner: 'other',
        name: 'other-repo',
        fullName: 'other/other-repo',
      })
      .returning();
    const [otherPr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: otherWorkspace!.id,
        repoId: otherRepo!.id,
        number: 1,
        title: 'Foreign PR',
        author: 'mallory',
        branch: 'feat/x',
        base: 'main',
        headSha: 'deadbeef',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'open',
      })
      .returning();

    const res = await app.inject({ method: 'GET', url: `/pulls/${otherPr!.id}/smart-diff` });
    expect(res.statusCode).toBe(404);
  });

  it('excludes dismissed findings from finding_lines', async () => {
    const { db } = pg.handle;
    const [review] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId, kind: 'review', score: 70, model: 'test' })
      .returning();
    await db.insert(t.findings).values([
      {
        reviewId: review!.id,
        file: 'src/service.ts',
        startLine: 7,
        endLine: 7,
        severity: 'WARNING',
        category: 'perf',
        title: 'Dismissed finding',
        rationale: 'Was wrong.',
        confidence: 0.5,
        kind: 'finding',
        dismissedAt: new Date(),
      },
      {
        reviewId: review!.id,
        file: 'src/service.ts',
        startLine: 8,
        endLine: 8,
        severity: 'WARNING',
        category: 'perf',
        title: 'Live finding',
        rationale: 'Still valid.',
        confidence: 0.6,
        kind: 'finding',
      },
    ]);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SmartDiffResponse;

    const coreGroup = body.groups.find((g) => g.role === 'core')!;
    const serviceFile = coreGroup.files.find((f) => f.path === 'src/service.ts')!;
    expect(serviceFile.finding_lines).toEqual([8]);
  });

  it('returns groups in fixed core/wiring/boilerplate order', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/smart-diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SmartDiffResponse;

    expect(body.groups).toHaveLength(3);
    expect(body.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
  });
});
