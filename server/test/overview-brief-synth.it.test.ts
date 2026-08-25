import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * Integration test: `overview/brief-synth` routes (SPEC-02 — Why + Risk
 * Brief), end-to-end over real HTTP + a real Postgres. Mirrors
 * `server/src/modules/overview/routes.it.test.ts` (the Intent-layer route
 * test) — same `test/helpers/pg.ts` Docker harness, same `fastify.inject()` +
 * `app.container.jobs.onIdle()` draining pattern, same per-test fresh `app`
 * (so `BriefSynthService`'s in-memory rate-limit `Map`s reset between cases).
 *
 * Covers SPEC-02 AC-16..AC-34 (the full 5-state matrix, SSE, rate limits,
 * cost/run attribution) plus L1 (a deleted anchor review still yields a
 * coherent staleness verdict). See
 * docs/superpowers/plans/2026-07-13-why-risk-brief-plan.md (T9).
 *
 * The model output payload only needs `{what, why, riskLevel, reviewFocus}`
 * (`reviewFocus: []` sidesteps needing real finding ids — that matching logic
 * is T12's `postprocess.ts`, already unit-tested there). None of the PRs here
 * carry `pr_files` rows, so `assembleBriefInput`'s blast/diff-stats calls are
 * exercised on their safe "no data" fallbacks (see `RepoIntelService.getBlastRadius`
 * — a repo with no `clonePath` and zero changed files degrades to an empty
 * result without needing a real git clone or repo-intel index).
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[overview/brief-synth] Docker not available — skipping integration tests.');
}

const FIXED_BRIEF_PAYLOAD = {
  what: 'Adds rate limiting to public API endpoints.',
  why: 'Prevents abuse from unauthenticated clients hammering public routes.',
  riskLevel: 'medium',
  reviewFocus: [] as { findingId: string; note: string }[],
};

let uniqueCounter = 0;
function uniqueSuffix(): string {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}`;
}

d('overview/brief-synth routes', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;
  let prCounter: number;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    const { db } = pg.handle;
    // Clean brief-synth + PR-scoped tables (incl. the job queue itself) so
    // every test starts from a clean, independently-countable slate.
    await db.delete(t.jobs);
    await db.delete(t.findings);
    await db.delete(t.reviews);
    await db.delete(t.agentRuns);
    await db.delete(t.prBrief);
    await db.delete(t.prIntent);
    await db.delete(t.prFiles);
    await db.delete(t.pullRequests);

    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;
    prCounter = 0;

    const [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: `brief-synth-repo-${uniqueSuffix()}`,
        fullName: `acme/brief-synth-repo-${uniqueSuffix()}`,
      })
      .returning();
    repoId = repo!.id;
  });

  function makeApp(llm: MockLLMProvider = new MockLLMProvider('anthropic', { structured: FIXED_BRIEF_PAYLOAD })) {
    return buildApp({
      db: pg.handle.db,
      overrides: {
        llm: { anthropic: llm },
        featureModelResolver: async () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
      },
    });
  }

  function nextNumber(): number {
    prCounter += 1;
    return prCounter;
  }

  async function insertPr(overrides: Record<string, unknown> = {}): Promise<string> {
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: nextNumber(),
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: `feat/rl-${uniqueSuffix()}`,
        base: 'main',
        headSha: 'sha-original',
        status: 'needs_review',
        ...overrides,
      })
      .returning();
    return pr!.id;
  }

  async function insertIntent(prId: string, opts: { computedAt?: Date } = {}): Promise<void> {
    await pg.handle.db.insert(t.prIntent).values({
      prId,
      intent: 'Add rate limiting to public API endpoints.',
      headSha: 'intent-sha',
      bodyHash: 'intent-body-hash',
      riskAreas: [{ icon: 'shield', label: 'Auth bypass risk' }],
      model: 'claude-haiku-4-5-20251001',
      computedAt: opts.computedAt ?? new Date(),
    });
  }

  async function insertReview(
    prId: string,
    opts: { createdAt?: Date; agentId?: string | null } = {},
  ): Promise<string> {
    const [review] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId,
        agentId: opts.agentId ?? null,
        kind: 'review',
        verdict: 'approve',
        summary: 'Looks fine',
        score: 90,
        model: 'gpt-4o-mini',
        createdAt: opts.createdAt ?? new Date(),
      })
      .returning();
    return review!.id;
  }

  /** A PR with both preconditions (intent + a qualifying review) already met. */
  async function insertReadyPr(): Promise<{ prId: string; reviewId: string }> {
    const prId = await insertPr();
    await insertIntent(prId);
    const reviewId = await insertReview(prId);
    return { prId, reviewId };
  }

  async function countBriefSynthJobs(): Promise<number> {
    const rows = await pg.handle.db.select().from(t.jobs).where(eq(t.jobs.kind, 'overview.brief_synth'));
    return rows.length;
  }

  // ---------------------------------------------------------------- AC-16..18

  it('AC-16: no intent row → not_ready listing "intent", no job enqueued', async () => {
    const app = await makeApp();
    const prId = await insertPr();
    await insertReview(prId); // review exists; intent does not

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect(body.missing).toContain('intent');
    expect(await countBriefSynthJobs()).toBe(0);

    await app.close();
  });

  it('AC-17: intent present but no qualifying review → not_ready listing "review"', async () => {
    const app = await makeApp();
    const prId = await insertPr();
    await insertIntent(prId);

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect(body.missing).toContain('review');
    expect(await countBriefSynthJobs()).toBe(0);

    await app.close();
  });

  it('AC-18: both intent and review absent → missing contains both entries', async () => {
    const app = await makeApp();
    const prId = await insertPr();

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect([...body.missing].sort()).toEqual(['intent', 'review']);
    expect(await countBriefSynthJobs()).toBe(0);

    await app.close();
  });

  // ---------------------------------------------------------------- AC-19/20

  it('AC-19/20: cold GET computes; draining the queue then a warm GET is ready with no new job', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();

    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(cold.statusCode).toBe(200);
    const coldBody = cold.json();
    expect(coldBody.status).toBe('computing');
    expect(typeof coldBody.runId).toBe('string');
    expect(await countBriefSynthJobs()).toBe(1);

    await app.container.jobs.onIdle();

    const warm = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(warm.statusCode).toBe(200);
    const warmBody = warm.json();
    expect(warmBody.status).toBe('ready');
    expect(warmBody.data.what).toBe(FIXED_BRIEF_PAYLOAD.what);
    expect(warmBody.data.model).toBe('claude-haiku-4-5-20251001');
    expect(typeof warmBody.data.computedAt).toBe('string');

    // Warm + fresh: a second GET must not enqueue anything new (AC-20).
    const jobsAfterFirstReady = await countBriefSynthJobs();
    const warm2 = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(warm2.json().status).toBe('ready');
    expect(await countBriefSynthJobs()).toBe(jobsAfterFirstReady);

    await app.close();
  });

  // ---------------------------------------------------------------- AC-21..25

  it('AC-21: head_sha drift → ready-stale including "head_sha"', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();
    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();

    await pg.handle.db.update(t.pullRequests).set({ headSha: 'sha-changed' }).where(eq(t.pullRequests.id, prId));

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toEqual(['head_sha']);

    await app.close();
  });

  it('AC-22: a newer review completing → ready-stale including "new_review"', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();
    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();

    await insertReview(prId, { createdAt: new Date(Date.now() + 60_000) });

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toEqual(['new_review']);

    await app.close();
  });

  it('AC-23: intent recomputed (later computedAt) → ready-stale including "intent"', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();
    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();

    // Simulate an intent recompute (T-service upsert) — later computedAt, same PK.
    await pg.handle.db
      .update(t.prIntent)
      .set({ computedAt: new Date(Date.now() + 60_000) })
      .where(eq(t.prIntent.prId, prId));

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toEqual(['intent']);

    await app.close();
  });

  it('AC-24: head_sha AND a newer review both drift → each stale reason listed exactly once', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();
    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();

    await pg.handle.db.update(t.pullRequests).set({ headSha: 'sha-changed-2' }).where(eq(t.pullRequests.id, prId));
    await insertReview(prId, { createdAt: new Date(Date.now() + 60_000) });

    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toHaveLength(2);
    expect([...body.staleReasons].sort()).toEqual(['head_sha', 'new_review']);

    await app.close();
  });

  it('AC-25: repeated GETs on a stale row keep serving the same cached data, no auto-enqueue', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();
    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();

    await pg.handle.db.update(t.pullRequests).set({ headSha: 'sha-changed-3' }).where(eq(t.pullRequests.id, prId));

    const jobsBefore = await countBriefSynthJobs();
    const first = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    const second = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(first.json().status).toBe('ready-stale');
    expect(second.json().status).toBe('ready-stale');
    expect(first.json().data.computedAt).toBe(second.json().data.computedAt);
    expect(await countBriefSynthJobs()).toBe(jobsBefore);

    await app.close();
  });

  // ------------------------------------------------------------------- AC-26

  it('AC-26: one endpoint carries the full state matrix (not_ready → computing → ready → ready-stale)', async () => {
    const app = await makeApp();
    const prId = await insertPr();

    let res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.json().status).toBe('not_ready');

    await insertIntent(prId);
    await insertReview(prId);

    res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.json().status).toBe('computing');
    await app.container.jobs.onIdle();

    res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.json().status).toBe('ready');

    await pg.handle.db.update(t.pullRequests).set({ headSha: 'sha-drift' }).where(eq(t.pullRequests.id, prId));
    res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.json().status).toBe('ready-stale');

    await app.close();
  });

  // ------------------------------------------------------------------- AC-27

  it('AC-27: refresh on an already-ready PR still enqueues a new compute', async () => {
    const llm = new MockLLMProvider('anthropic', { structured: FIXED_BRIEF_PAYLOAD });
    const app = await makeApp(llm);
    const { prId } = await insertReadyPr();

    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();
    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);

    const ready = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(ready.json().status).toBe('ready');

    const refresh = await app.inject({ method: 'POST', url: `/pulls/${prId}/overview/brief-synth/refresh` });
    expect(refresh.statusCode).toBe(202);
    expect(typeof refresh.json().runId).toBe('string');
    await app.container.jobs.onIdle();

    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(2);

    await app.close();
  });

  // ------------------------------------------------------------------- AC-28

  it('AC-28: refresh while intent/review is missing is rejected (4xx), no job, pr_brief unchanged', async () => {
    const app = await makeApp();
    const prId = await insertPr(); // neither intent nor review

    const jobsBefore = await countBriefSynthJobs();
    const res = await app.inject({ method: 'POST', url: `/pulls/${prId}/overview/brief-synth/refresh` });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await countBriefSynthJobs()).toBe(jobsBefore);

    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    expect(rows).toHaveLength(0);

    await app.close();
  });

  // ------------------------------------------------------------------- AC-29

  it('AC-29: a second refresh within 60s returns 429 with retryAfterSeconds', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();

    const first = await app.inject({ method: 'POST', url: `/pulls/${prId}/overview/brief-synth/refresh` });
    expect(first.statusCode).toBe(202);
    await app.container.jobs.onIdle();

    const second = await app.inject({ method: 'POST', url: `/pulls/${prId}/overview/brief-synth/refresh` });
    expect(second.statusCode).toBe(429);
    const body = second.json();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details).toHaveProperty('retryAfterSeconds');

    await app.close();
  });

  // --------------------------------------------------------------- AC-30/31

  it(
    'AC-30 + AC-31(a): the 31st workspace compute/refresh is rate-limited; ' +
      "Intent's own budget stays untouched",
    async () => {
      const app = await makeApp();

      // 31 distinct PRs (each with intent + a qualifying review), rather than
      // looping refreshes on ONE PR — the 1-refresh/min/PR cooldown (AC-29)
      // would otherwise reject the 2nd single-PR refresh long before the 31st
      // request could ever exercise the workspace-level counter (L3).
      const prIds: string[] = [];
      for (let i = 0; i < 31; i++) {
        const { prId } = await insertReadyPr();
        prIds.push(prId);
      }

      for (let i = 0; i < 30; i++) {
        const res = await app.inject({
          method: 'POST',
          url: `/pulls/${prIds[i]}/overview/brief-synth/refresh`,
        });
        expect(res.statusCode).toBe(202);
      }

      const res31 = await app.inject({
        method: 'POST',
        url: `/pulls/${prIds[30]}/overview/brief-synth/refresh`,
      });
      expect(res31.statusCode).toBe(429);
      expect(res31.json().error.code).toBe('rate_limited');

      // AC-31: brief-synth's workspace budget is now exhausted, but the
      // Intent layer tracks its OWN independent counter — a fresh Intent
      // compute on a brand-new PR must still succeed.
      const intentPrId = await insertPr();
      const intentRes = await app.inject({ method: 'GET', url: `/pulls/${intentPrId}/overview/intent` });
      expect(intentRes.statusCode).toBe(200);
      expect(intentRes.json().status).toBe('computing');

      await app.container.jobs.onIdle();
      await app.close();
    },
  );

  it('AC-31(b): exhausting the Intent workspace budget does not block a brief-synth compute', async () => {
    const app = await makeApp();

    for (let i = 0; i < 30; i++) {
      const prId = await insertPr();
      const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/intent` });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('computing');
    }

    // Sanity-check the setup: Intent's OWN budget really is exhausted now.
    const overflowPrId = await insertPr();
    const overflow = await app.inject({ method: 'GET', url: `/pulls/${overflowPrId}/overview/intent` });
    expect(overflow.statusCode).toBe(429);

    // brief-synth's independent counter is untouched by Intent's exhaustion.
    const { prId: briefPrId } = await insertReadyPr();
    const briefRes = await app.inject({ method: 'GET', url: `/pulls/${briefPrId}/overview/brief-synth` });
    expect(briefRes.statusCode).toBe(200);
    expect(briefRes.json().status).toBe('computing');

    await app.container.jobs.onIdle();
    await app.close();
  });

  // --------------------------------------------------------------- AC-32/33

  it("AC-32/33: SSE emits 'info' before 'done'; the pr_brief row exists only once 'done' is observed", async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();

    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    const runId = cold.json().runId as string;

    // Before the job has had any chance to run: no row yet.
    const before = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    expect(before).toHaveLength(0);

    // Subscribe directly on the in-process bus (not just the HTTP stream) so
    // we can tie a DB read to the EXACT 'done' event instance — `.inject()`
    // alone only resolves once the whole SSE stream has ended, which can't
    // distinguish "present when done fired" from "present eventually".
    let capturedAtDone: Promise<unknown[]> | undefined;
    const unsubscribe = app.container.runBus.subscribe(runId, (e) => {
      if (e.kind === 'done' && capturedAtDone === undefined) {
        capturedAtDone = pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
      }
    });

    const streamPromise = app.inject({
      method: 'GET',
      url: `/pulls/${prId}/overview/brief-synth/stream?runId=${runId}`,
    });
    await app.container.jobs.onIdle();
    const sse = await streamPromise;
    unsubscribe();

    expect(sse.statusCode).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    const infoIdx = sse.payload.indexOf('event: info');
    const doneIdx = sse.payload.indexOf('event: done');
    expect(infoIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(infoIdx);

    expect(capturedAtDone).toBeDefined();
    const rowsAtDone = await capturedAtDone!;
    expect(rowsAtDone).toHaveLength(1);

    await app.close();
  });

  // ------------------------------------------------------------------- AC-34

  it('AC-34: GET /pulls/:id/runs includes a row attributable to the refresh-returned runId', async () => {
    const app = await makeApp();
    const { prId } = await insertReadyPr();

    await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    await app.container.jobs.onIdle();

    const refresh = await app.inject({ method: 'POST', url: `/pulls/${prId}/overview/brief-synth/refresh` });
    expect(refresh.statusCode).toBe(202);
    const runId = refresh.json().runId as string;
    await app.container.jobs.onIdle();

    const runsRes = await app.inject({ method: 'GET', url: `/pulls/${prId}/runs` });
    expect(runsRes.statusCode).toBe(200);
    const runs = runsRes.json() as { run_id: string }[];
    expect(runs.some((r) => r.run_id === runId)).toBe(true);

    await app.close();
  });

  // ----------------------------------------------------------------------- L1

  it('L1: a deleted anchor review (null cached reviewId) still yields a coherent ready-stale verdict', async () => {
    const app = await makeApp();
    const prId = await insertPr();
    await insertIntent(prId);
    await insertReview(prId, { createdAt: new Date('2026-01-01T00:00:00Z') });
    const newerReviewId = await insertReview(prId, { createdAt: new Date('2026-01-02T00:00:00Z') });

    // Cold compute anchors basedOn.reviewId to the LATEST review.
    const cold = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(cold.json().status).toBe('computing');
    await app.container.jobs.onIdle();

    const ready = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(ready.json().status).toBe('ready');
    expect(ready.json().data.basedOn.reviewId).toBe(newerReviewId);

    // Delete the anchor review — pr_brief.review_id is ON DELETE SET NULL.
    await pg.handle.db.delete(t.reviews).where(eq(t.reviews.id, newerReviewId));

    const cachedRow = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    expect(cachedRow[0]!.reviewId).toBeNull();

    // The older review still qualifies as "latest" now the anchor is gone, so
    // the card is not_ready — it's a coherent ready-stale verdict pointing at
    // the drift, not a crash and not a silently-wrong "still fresh" verdict.
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/overview/brief-synth` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready-stale');
    expect(body.staleReasons).toContain('new_review');
    expect(body.data.basedOn.reviewId).toBeNull();

    await app.close();
  });
});
