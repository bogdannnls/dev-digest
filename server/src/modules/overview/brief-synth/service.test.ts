import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as t from '../../../db/schema.js';
import type { Container } from '../../../platform/container.js';
import type { RunEventKind } from '@devdigest/shared';
import { RateLimitedError, ValidationError, NotFoundError } from '../../../platform/errors.js';
import type { BriefSynthInput } from './assemble-input.js';
import type { SynthesizeBriefResult } from './synthesize.js';
import type { BriefSynthRow } from './repository.js';
import type { IntentRow } from '../intent/repository.js';
import type { LatestReviewRow } from '../../_shared/latest-review.js';

// Sibling modules mocked so this service test drives BriefSynthService directly
// without exercising the full DB/LLM pipeline underneath assembleBriefInput /
// synthesizeBrief — mirrors overview/intent/service.test.ts's approach of
// mocking `./references.js` / `./extract.js`. `postprocess.ts` is intentionally
// NOT mocked (it's pure/deterministic) so the job handler's real pipeline
// wiring is exercised end-to-end at this layer.
vi.mock('../../_shared/latest-review.js', () => ({
  latestReviewForPr: vi.fn(),
}));
vi.mock('./assemble-input.js', () => ({
  assembleBriefInput: vi.fn(),
}));
vi.mock('./synthesize.js', () => ({
  synthesizeBrief: vi.fn(),
}));
// Mocked ONLY for the AC-31 cross-service test below, which constructs a real
// IntentService against the same fake container to prove the rate-limit
// counters never share state.
vi.mock('../intent/references.js', () => ({
  collectReferences: vi.fn().mockResolvedValue([]),
}));
vi.mock('../intent/extract.js', () => ({
  extractIntent: vi.fn().mockResolvedValue({
    dto: {
      goal: 'Intent goal.',
      inScope: [],
      outOfScope: [],
      riskAreas: [],
      references: [],
      model: 'claude-haiku-4-5-20251001',
      cost: { tokensIn: 10, tokensOut: 5, usd: 0.0001 },
      computedAt: '2026-07-10T10:00:00.000Z',
    },
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.0001,
    model: 'claude-haiku-4-5-20251001',
  }),
}));

const { latestReviewForPr } = await import('../../_shared/latest-review.js');
const { assembleBriefInput } = await import('./assemble-input.js');
const { synthesizeBrief } = await import('./synthesize.js');
const { BriefSynthService } = await import('./service.js');
const { IntentService } = await import('../intent/service.js');

const PR_ID = 'pr-1';
const WS_ID = 'ws-1';

type PrRow = { id: string; workspaceId: string; repoId: string; headSha: string };

const PR_ROW: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1' };

/** IntentRepository.get()'s return shape — only `data.computedAt` matters here. */
const INTENT_ROW: IntentRow = {
  prId: PR_ID,
  headSha: 'sha-1',
  bodyHash: 'hash-1',
  data: {
    goal: 'Add rate limiting.',
    inScope: ['add middleware'],
    outOfScope: [],
    riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
    references: [],
    model: 'claude-haiku-4-5-20251001',
    cost: { tokensIn: 100, tokensOut: 50, usd: 0.0009 },
    computedAt: '2026-07-10T10:00:00.000Z',
  },
};

/** latestReviewForPr()'s return shape. */
const REVIEW_ROW: LatestReviewRow = { id: 'review-1', agentId: 'agent-1' };

/**
 * A minimal valid assembleBriefInput() result whose `basedOn` matches
 * PR_ROW/INTENT_ROW/REVIEW_ROW above. Finding severity is deliberately
 * 'WARNING' (not 'CRITICAL') so postprocess.ts's riskLevel floor (T12, out
 * of this task's scope) never fires unintentionally in state-machine tests
 * that don't care about riskLevel.
 */
const DEFAULT_INPUT: BriefSynthInput = {
  basedOn: { headSha: 'sha-1', reviewId: 'review-1', intentComputedAt: INTENT_ROW.data.computedAt },
  intent: {
    goal: 'Add rate limiting.',
    inScope: ['add middleware'],
    outOfScope: [],
    riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
    references: [],
  },
  findings: [
    {
      id: 'finding-1',
      file: 'src/auth.ts',
      startLine: 10,
      endLine: 12,
      severity: 'WARNING',
      category: 'security',
      title: 'Missing test coverage',
      rationale: 'No regression test for the fallback path.',
    },
  ],
  blast: { changedSymbols: [], callers: [], impactedEndpoints: [] },
  diffStats: { groups: [], split_suggestion: { too_big: false, total_lines: 0, proposed_splits: [] } },
  attachedSpecs: [],
};

const DEFAULT_SYNTH_RESULT: SynthesizeBriefResult = {
  data: {
    what: 'Adds rate limiting to the public API.',
    why: 'Prevents abuse of unauthenticated endpoints.',
    riskLevel: 'medium',
    reviewFocus: [{ findingId: 'finding-1', note: 'Add a regression test.' }],
  },
  tokensIn: 200,
  tokensOut: 80,
  costUsd: 0.0012,
  model: 'claude-haiku-4-5-20251001',
};

/**
 * Also covers `t.repos`/`t.prFiles` (empty/defaulted) so the AC-31
 * cross-service test below — which constructs a real `IntentService` against
 * this same fake container — can let its job handler run its own DB reads
 * (`repos`, `prFiles`) without hitting an "unexpected table" guard.
 */
function makeDb(pr: PrRow | undefined) {
  const repoRow = { id: pr?.repoId ?? 'repo-1', owner: 'acme', name: 'widgets' };
  const from = (table: unknown) => ({
    where: async () => {
      if (table === t.pullRequests) return pr ? [pr] : [];
      if (table === t.repos) return [repoRow];
      if (table === t.prFiles) return [];
      throw new Error('unexpected table in test fake db');
    },
  });
  return { select: () => ({ from }) };
}

/** Builds a Container-shaped object with just what BriefSynthService touches. */
function makeContainer(opts: { pr: PrRow | undefined }) {
  const jobsRegistered = new Map<string, (payload: unknown) => Promise<void>>();
  const enqueue = vi.fn(async (_ws: string, kind: string, payload: unknown) => {
    const handler = jobsRegistered.get(kind);
    if (handler) await handler(payload);
    return { id: 'job-1', done: Promise.resolve() };
  });

  const published: Array<{ runId: string; kind: RunEventKind; msg: string; data?: unknown }> = [];
  const completed: string[] = [];

  const createAgentRun = vi.fn().mockResolvedValue('run-1');
  const completeAgentRun = vi.fn().mockResolvedValue(undefined);

  const container = {
    db: makeDb(opts.pr),
    jobs: {
      register: (kind: string, handler: (payload: unknown) => Promise<void>) => {
        jobsRegistered.set(kind, handler);
      },
      enqueue,
    },
    runBus: {
      publish: (runId: string, kind: RunEventKind, msg: string, data?: unknown) => {
        published.push({ runId, kind, msg, data });
      },
      complete: (runId: string) => {
        completed.push(runId);
      },
    },
    reviewRepo: {
      createAgentRun,
      completeAgentRun,
    },
  } as unknown as Container;

  return { container, enqueue, published, completed, createAgentRun, completeAgentRun };
}

/** Wires the mocks/repo doubles a "happy path" job run needs. */
function wireHappyPath(service: InstanceType<typeof BriefSynthService>) {
  service['intentRepo'].get = vi.fn().mockResolvedValue(INTENT_ROW);
  vi.mocked(latestReviewForPr).mockResolvedValue(REVIEW_ROW);
  vi.mocked(assembleBriefInput).mockResolvedValue(DEFAULT_INPUT);
  vi.mocked(synthesizeBrief).mockResolvedValue(DEFAULT_SYNTH_RESULT);
  service['repo'].upsert = vi.fn().mockResolvedValue(undefined);
}

describe('BriefSynthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('not_ready (AC-16, AC-17, AC-18)', () => {
    it('missing intent only -> not_ready with missing: ["intent"]', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      service['intentRepo'].get = vi.fn().mockResolvedValue(null);
      vi.mocked(latestReviewForPr).mockResolvedValue(REVIEW_ROW);

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result).toEqual({ status: 'not_ready', missing: ['intent'] });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('missing review only -> not_ready with missing: ["review"]', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      service['intentRepo'].get = vi.fn().mockResolvedValue(INTENT_ROW);
      vi.mocked(latestReviewForPr).mockResolvedValue(null);

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result).toEqual({ status: 'not_ready', missing: ['review'] });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('missing both -> not_ready with missing: ["intent", "review"]', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      service['intentRepo'].get = vi.fn().mockResolvedValue(null);
      vi.mocked(latestReviewForPr).mockResolvedValue(null);

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result).toEqual({ status: 'not_ready', missing: ['intent', 'review'] });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('cold compute (AC-19, AC-10, AC-34)', () => {
    it('no cached row -> computing + runId; enqueues exactly once; job runs the full pipeline', async () => {
      const { container, enqueue, createAgentRun, completeAgentRun, published, completed } = makeContainer({
        pr: PR_ROW,
      });
      const service = new BriefSynthService(container);
      wireHappyPath(service);
      service['repo'].get = vi.fn().mockResolvedValue(null);

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result).toEqual({ status: 'computing', runId: 'run-1' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(createAgentRun).toHaveBeenCalledTimes(1);
      expect(createAgentRun).toHaveBeenCalledWith({
        workspaceId: WS_ID,
        agentId: null,
        prId: PR_ID,
        provider: null,
        model: null,
      });

      // AC-10: exactly one structured-synthesis call per job run.
      expect(vi.mocked(synthesizeBrief)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(assembleBriefInput)).toHaveBeenCalledTimes(1);

      // AC-38 (upsert) — the job commits before 'done'.
      expect(service['repo'].upsert).toHaveBeenCalledTimes(1);
      expect(service['repo'].upsert).toHaveBeenCalledWith(
        PR_ID,
        { headSha: 'sha-1', reviewId: 'review-1', intentComputedAt: INTENT_ROW.data.computedAt },
        expect.objectContaining({
          tokensIn: 200,
          tokensOut: 80,
          costUsd: 0.0012,
          model: 'claude-haiku-4-5-20251001',
        }),
      );

      // AC-34: the SAME runId returned to the caller is completed as 'done'.
      expect(completeAgentRun).toHaveBeenCalledTimes(1);
      expect(completeAgentRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'done', tokensIn: 200, tokensOut: 80, findingsCount: 0, grounding: 'n/a' }),
      );

      expect(published.some((p) => p.runId === 'run-1' && p.kind === 'done')).toBe(true);
      expect(completed).toEqual(['run-1']);
    });

    it('completes the agent_runs row as failed (not done) when synthesizeBrief throws (AC-34)', async () => {
      const { container, completeAgentRun, published, completed } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireHappyPath(service);
      service['repo'].get = vi.fn().mockResolvedValue(null);
      vi.mocked(synthesizeBrief).mockRejectedValueOnce(new Error('LLM exploded'));

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result).toEqual({ status: 'computing', runId: 'run-1' });
      expect(service['repo'].upsert).not.toHaveBeenCalled();
      expect(completeAgentRun).toHaveBeenCalledTimes(1);
      expect(completeAgentRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'failed', error: 'LLM exploded' }),
      );
      expect(published.some((p) => p.kind === 'error' && p.msg === 'LLM exploded')).toBe(true);
      expect(completed).toEqual(['run-1']);
    });

    it("publishes 'done' strictly after repo.upsert resolves (AC-33)", async () => {
      const { container, published } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireHappyPath(service);
      service['repo'].get = vi.fn().mockResolvedValue(null);

      const order: string[] = [];
      service['repo'].upsert = vi.fn().mockImplementation(async () => {
        order.push('upsert');
      });
      const originalPublish = container.runBus.publish;
      container.runBus.publish = ((...args: Parameters<typeof originalPublish>) => {
        if (args[1] === 'done') order.push('done');
        return originalPublish(...args);
      }) as typeof container.runBus.publish;

      await service.getOrCompute(WS_ID, PR_ID);

      expect(order).toEqual(['upsert', 'done']);
      expect(published.some((p) => p.kind === 'done')).toBe(true);
    });
  });

  describe('ready / ready-stale (AC-20..25)', () => {
    const FRESH_ROW: BriefSynthRow = {
      prId: PR_ID,
      data: {
        ...DEFAULT_SYNTH_RESULT.data,
        risks: [],
        model: 'claude-haiku-4-5-20251001',
        cost: { tokensIn: 1, tokensOut: 1, usd: 0.001 },
        computedAt: '2026-07-10T12:00:00.000Z',
      },
      basedOn: { headSha: 'sha-1', reviewId: 'review-1', intentComputedAt: INTENT_ROW.data.computedAt },
    };

    function wireReadRow(service: InstanceType<typeof BriefSynthService>, row: BriefSynthRow | null) {
      service['intentRepo'].get = vi.fn().mockResolvedValue(INTENT_ROW);
      vi.mocked(latestReviewForPr).mockResolvedValue(REVIEW_ROW);
      service['repo'].get = vi.fn().mockResolvedValue(row);
    }

    it('cached basedOn matches current state -> ready, no enqueue', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireReadRow(service, FRESH_ROW);

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result).toEqual({ status: 'ready', data: { ...FRESH_ROW.data, basedOn: FRESH_ROW.basedOn } });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('head_sha drift only -> ready-stale with staleReasons: ["head_sha"]', async () => {
      const { container, enqueue } = makeContainer({ pr: { ...PR_ROW, headSha: 'sha-2' } });
      const service = new BriefSynthService(container);
      wireReadRow(service, FRESH_ROW);

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result.status).toBe('ready-stale');
      expect(result).toMatchObject({ staleReasons: ['head_sha'] });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('newer review only -> ready-stale with staleReasons: ["new_review"]', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireReadRow(service, FRESH_ROW);
      vi.mocked(latestReviewForPr).mockResolvedValue({ id: 'review-2', agentId: 'agent-1' });

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result.status).toBe('ready-stale');
      expect(result).toMatchObject({ staleReasons: ['new_review'] });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('recomputed intent only -> ready-stale with staleReasons: ["intent"]', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireReadRow(service, FRESH_ROW);
      service['intentRepo'].get = vi.fn().mockResolvedValue({
        ...INTENT_ROW,
        data: { ...INTENT_ROW.data, computedAt: '2026-07-11T00:00:00.000Z' },
      });

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result.status).toBe('ready-stale');
      expect(result).toMatchObject({ staleReasons: ['intent'] });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('all three drifted -> staleReasons contains each exactly once, deduplicated (AC-24)', async () => {
      const { container, enqueue } = makeContainer({ pr: { ...PR_ROW, headSha: 'sha-2' } });
      const service = new BriefSynthService(container);
      wireReadRow(service, FRESH_ROW);
      vi.mocked(latestReviewForPr).mockResolvedValue({ id: 'review-2', agentId: 'agent-1' });
      service['intentRepo'].get = vi.fn().mockResolvedValue({
        ...INTENT_ROW,
        data: { ...INTENT_ROW.data, computedAt: '2026-07-11T00:00:00.000Z' },
      });

      const result = await service.getOrCompute(WS_ID, PR_ID);

      expect(result.status).toBe('ready-stale');
      if (result.status !== 'ready-stale') throw new Error('expected ready-stale');
      expect(result.staleReasons).toEqual(['head_sha', 'new_review', 'intent']);
      expect(new Set(result.staleReasons).size).toBe(result.staleReasons.length);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('a stale row is served as-is across repeated GETs -- same computedAt, no auto-enqueue (AC-25)', async () => {
      const { container, enqueue } = makeContainer({ pr: { ...PR_ROW, headSha: 'sha-2' } });
      const service = new BriefSynthService(container);
      wireReadRow(service, FRESH_ROW);

      const first = await service.getOrCompute(WS_ID, PR_ID);
      const second = await service.getOrCompute(WS_ID, PR_ID);

      expect(first.status).toBe('ready-stale');
      expect(second.status).toBe('ready-stale');
      if (first.status !== 'ready-stale' || second.status !== 'ready-stale') {
        throw new Error('expected ready-stale');
      }
      expect(first.data.computedAt).toBe(second.data.computedAt);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('tolerates a null cached reviewId (review deleted after compute -- L1) without throwing', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireReadRow(service, { ...FRESH_ROW, basedOn: { ...FRESH_ROW.basedOn, reviewId: null } });

      const result = await service.getOrCompute(WS_ID, PR_ID);

      // The cached review no longer matches the currently-latest review id,
      // so this is coherently reported as stale (new_review) — not a throw.
      expect(result.status).toBe('ready-stale');
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('refresh (AC-27, AC-28)', () => {
    it('enqueues unconditionally even when the cached row is already ready', async () => {
      const { container, enqueue } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      wireHappyPath(service);

      const result = await service.refresh(WS_ID, PR_ID);

      expect(result.runId).toBe('run-1');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('rejects with a 4xx AppError and does not enqueue when intent is missing', async () => {
      const { container, enqueue, createAgentRun } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      service['intentRepo'].get = vi.fn().mockResolvedValue(null);
      vi.mocked(latestReviewForPr).mockResolvedValue(REVIEW_ROW);

      await expect(service.refresh(WS_ID, PR_ID)).rejects.toBeInstanceOf(ValidationError);
      await expect(service.refresh(WS_ID, PR_ID)).rejects.toMatchObject({ statusCode: expect.any(Number) });
      expect(enqueue).not.toHaveBeenCalled();
      expect(createAgentRun).not.toHaveBeenCalled();
    });

    it('rejects with a 4xx AppError and does not enqueue when the qualifying review is missing', async () => {
      const { container, enqueue, createAgentRun } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      service['intentRepo'].get = vi.fn().mockResolvedValue(INTENT_ROW);
      vi.mocked(latestReviewForPr).mockResolvedValue(null);

      await expect(service.refresh(WS_ID, PR_ID)).rejects.toBeInstanceOf(ValidationError);
      expect(enqueue).not.toHaveBeenCalled();
      expect(createAgentRun).not.toHaveBeenCalled();
    });

    it('the 4xx rejection carries a real HTTP status < 500', async () => {
      const { container } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container);
      service['intentRepo'].get = vi.fn().mockResolvedValue(null);
      vi.mocked(latestReviewForPr).mockResolvedValue(null);

      try {
        await service.refresh(WS_ID, PR_ID);
        throw new Error('expected refresh to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).statusCode).toBeGreaterThanOrEqual(400);
        expect((err as ValidationError).statusCode).toBeLessThan(500);
      }
    });

  });

  describe('loadPr guard', () => {
    it('throws NotFoundError when the PR does not exist', async () => {
      const { container } = makeContainer({ pr: undefined });
      const service = new BriefSynthService(container);
      await expect(service.getOrCompute(WS_ID, 'missing-pr')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('rate limits (fake clock, AC-29, AC-30)', () => {
    it('a 2nd refresh for the same PR within 60s throws RateLimitedError', async () => {
      let clock = 0;
      const { container } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container, () => clock);
      wireHappyPath(service);

      await service.refresh(WS_ID, PR_ID);
      clock += 30_000; // within the 60s window
      await expect(service.refresh(WS_ID, PR_ID)).rejects.toBeInstanceOf(RateLimitedError);

      clock += 40_000; // now past 60s since the first refresh
      await expect(service.refresh(WS_ID, PR_ID)).resolves.toBeDefined();
    });

    it('a 31st compute/refresh within the same workspace inside a rolling hour throws RateLimitedError', async () => {
      let clock = 0;
      const { container } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container, () => clock);
      wireHappyPath(service);
      service['repo'].get = vi.fn().mockResolvedValue(null);

      for (let i = 0; i < 30; i++) {
        clock += 60_000;
        const result = await service.getOrCompute(WS_ID, PR_ID);
        expect(result.status).toBe('computing');
      }

      clock += 60_000;
      await expect(service.getOrCompute(WS_ID, PR_ID)).rejects.toBeInstanceOf(RateLimitedError);
    });

    it("brief-synth's rate-limit counters are independent of IntentService's (AC-31)", async () => {
      let clock = 0;
      const { container } = makeContainer({ pr: PR_ROW });
      const briefService = new BriefSynthService(container, () => clock);
      wireHappyPath(briefService);
      briefService['repo'].get = vi.fn().mockResolvedValue(null);

      const intentService = new IntentService(container, () => clock);
      intentService['repo'].get = vi.fn().mockResolvedValue(null);
      intentService['repo'].upsert = vi.fn().mockResolvedValue(undefined);

      // Exhaust brief-synth's own 30/hr workspace budget.
      for (let i = 0; i < 30; i++) {
        clock += 60_000;
        const result = await briefService.getOrCompute(WS_ID, PR_ID);
        expect(result.status).toBe('computing');
      }
      clock += 60_000;
      await expect(briefService.getOrCompute(WS_ID, PR_ID)).rejects.toBeInstanceOf(RateLimitedError);

      // Intent's own budget is untouched — its cold compute still succeeds.
      const intentResult = await intentService.getOrCompute(WS_ID, PR_ID);
      expect(intentResult.status).toBe('computing');

      // ...and the reverse: exhausting Intent's budget doesn't touch brief-synth's.
      const freshBrief = new BriefSynthService(container, () => clock);
      wireHappyPath(freshBrief);
      freshBrief['repo'].get = vi.fn().mockResolvedValue(null);
      const freshResult = await freshBrief.getOrCompute(WS_ID, PR_ID);
      expect(freshResult.status).toBe('computing');
    });
  });

  describe('cost persistence (AC-36)', () => {
    it('two refreshes with different token/cost counts persist only the most recent value, not a sum', async () => {
      let clock = 0;
      const { container } = makeContainer({ pr: PR_ROW });
      const service = new BriefSynthService(container, () => clock);
      wireHappyPath(service);
      const upsert = vi.fn().mockResolvedValue(undefined);
      service['repo'].upsert = upsert;

      vi.mocked(synthesizeBrief).mockResolvedValueOnce({
        ...DEFAULT_SYNTH_RESULT,
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.001,
      });
      await service.refresh(WS_ID, PR_ID);

      clock += 61_000; // past the 1/min/PR refresh window

      vi.mocked(synthesizeBrief).mockResolvedValueOnce({
        ...DEFAULT_SYNTH_RESULT,
        tokensIn: 9000,
        tokensOut: 1400,
        costUsd: 0.02,
      });
      await service.refresh(WS_ID, PR_ID);

      expect(upsert).toHaveBeenCalledTimes(2);
      const secondCallResult = upsert.mock.calls[1]![2] as { tokensIn: number; tokensOut: number; costUsd: number };
      expect(secondCallResult.tokensIn).toBe(9000);
      expect(secondCallResult.tokensOut).toBe(1400);
      expect(secondCallResult.costUsd).toBe(0.02);
      // Not a cumulative sum of the two calls.
      expect(secondCallResult.tokensIn).not.toBe(100 + 9000);
    });
  });
});
