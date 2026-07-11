import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startPg, dockerAvailable, type PgFixture } from '../../../test/helpers/pg.js';
import { seed } from '../../db/seed.js';
import * as t from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { MockLLMProvider, MockSecretsProvider } from '../../adapters/mocks.js';

/**
 * PR Overview — Slice A (brief) has no HTTP-level test yet; this is the first
 * `.it.test.ts` for the `overview` module. It covers the Intent Layer (P1)
 * routes end-to-end against a real Postgres, per spec §14.2 items 1-5.
 *
 * The 429 scenario specifically exercises `IntentService`'s in-memory
 * per-PR/per-workspace rate limiter through a real HTTP round-trip — this
 * canNOT be proven by `@fastify/rate-limit` because that plugin is disabled
 * under `NODE_ENV=test` (see `server/src/app.ts` + `IntentService` docstring).
 *
 * `collectReferences`'s GitHub-issue collector casts `container.forgeClient`'s
 * result to the concrete `OctokitGitHubClient` (see `intent/references.ts`),
 * so it cannot be exercised via `ContainerOverrides.forge` (a `MockGitHubClient`
 * lacks `resolveLinkedIssues`). Instead, inject an empty `MockSecretsProvider`
 * so `container.forgeClient('github')` throws `ConfigError` (no GITHUB_TOKEN),
 * which the collector's try/catch maps to `references: []` — best-effort, per
 * spec §8.2. This is enough to exercise the full get/refresh/stale/429 flow;
 * reference-chip content is out of scope for this route-level test.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[overview/intent] Docker not available — skipping integration tests.');
}

const FIXED_INTENT_PAYLOAD = {
  goal: 'Add rate limiting to public API endpoints to prevent abuse.',
  inScope: ['Token-bucket limiter middleware', 'Public API routes'],
  outOfScope: ['Internal admin routes'],
  riskAreas: [{ icon: 'shield', label: 'Auth bypass risk' }],
};

d('overview/intent routes', () => {
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
    // Clean intent + PR-scoped tables between tests so each test is isolated.
    await db.delete(t.prIntent);
    await db.delete(t.prFiles);
    await db.delete(t.pullRequests);

    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    const [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: `intent-repo-${Date.now()}`,
        fullName: `acme/intent-repo-${Date.now()}`,
      })
      .returning();
    repoId = repo!.id;

    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 1,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: 'sha-original',
        status: 'needs_review',
        body: 'Add rate limiting. Closes #1.',
      })
      .returning();
    prId = pr!.id;

    await db.insert(t.prFiles).values([
      { prId, path: 'src/middleware/ratelimit.ts', additions: 84, deletions: 0 },
    ]);

    app = await buildApp({
      db,
      overrides: {
        llm: { anthropic: new MockLLMProvider('anthropic', { structured: FIXED_INTENT_PAYLOAD }) },
        secrets: new MockSecretsProvider(),
        featureModelResolver: async () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
      },
    });
  });

  it('cold GET computes, drains the job queue, then warm GET is ready', async () => {
    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(cold.statusCode).toBe(200);
    const coldBody = cold.json();
    expect(coldBody.status).toBe('computing');
    expect(typeof coldBody.runId).toBe('string');

    await app.container.jobs.onIdle();

    const warm = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(warm.statusCode).toBe(200);
    const warmBody = warm.json();
    expect(warmBody.status).toBe('ready');
    expect(warmBody.data.goal).toBe(FIXED_INTENT_PAYLOAD.goal);
    expect(warmBody.data.inScope).toEqual(FIXED_INTENT_PAYLOAD.inScope);
    expect(warmBody.data.outOfScope).toEqual(FIXED_INTENT_PAYLOAD.outOfScope);
    expect(warmBody.data.riskAreas).toEqual(FIXED_INTENT_PAYLOAD.riskAreas);
    expect(warmBody.data.model).toBe('claude-haiku-4-5-20251001');
    expect(typeof warmBody.data.computedAt).toBe('string');
  });

  it('POST refresh forces recompute (calls the LLM again)', async () => {
    const llm = new MockLLMProvider('anthropic', { structured: FIXED_INTENT_PAYLOAD });
    app = await buildApp({
      db: pg.handle.db,
      overrides: {
        llm: { anthropic: llm },
        secrets: new MockSecretsProvider(),
        featureModelResolver: async () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
      },
    });

    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(cold.json().status).toBe('computing');
    await app.container.jobs.onIdle();
    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);

    const refresh = await app.inject({
      method: 'POST',
      url: `/pulls/${prId}/overview/intent/refresh`,
    });
    expect(refresh.statusCode).toBe(202);
    expect(typeof refresh.json().runId).toBe('string');
    await app.container.jobs.onIdle();

    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(2);
  });

  it('mutating pullRequests.headSha marks the card ready-stale with head_sha', async () => {
    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(cold.json().status).toBe('computing');
    await app.container.jobs.onIdle();

    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'sha-changed' })
      .where(eq(t.pullRequests.id, prId));

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toEqual(['head_sha']);
  });

  it('mutating pullRequests.body marks the card ready-stale with body', async () => {
    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(cold.json().status).toBe('computing');
    await app.container.jobs.onIdle();

    await pg.handle.db
      .update(t.pullRequests)
      .set({ body: 'A completely different PR description now.' })
      .where(eq(t.pullRequests.id, prId));

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toEqual(['body']);
  });

  it('a second refresh within 60s returns 429 with retry-after details', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/pulls/${prId}/overview/intent/refresh`,
    });
    expect(first.statusCode).toBe(202);
    await app.container.jobs.onIdle();

    const second = await app.inject({
      method: 'POST',
      url: `/pulls/${prId}/overview/intent/refresh`,
    });
    expect(second.statusCode).toBe(429);
    const body = second.json();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details).toHaveProperty('retryAfterSeconds');
  });
});
