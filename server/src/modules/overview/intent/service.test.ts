import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as t from '../../../db/schema.js';
import type { Container } from '../../../platform/container.js';
import type { RunEventKind } from '@devdigest/shared';
import { RateLimitedError, NotFoundError } from '../../../platform/errors.js';
import type { ExtractIntentResult } from './extract.js';
import type { CollectedReference } from './types.js';
import { bodyHashOf } from './helpers.js';

vi.mock('./references.js', () => ({
  collectReferences: vi.fn(),
}));
vi.mock('./extract.js', () => ({
  extractIntent: vi.fn(),
}));

const { collectReferences } = await import('./references.js');
const { extractIntent } = await import('./extract.js');
const { IntentService } = await import('./service.js');

const PR_ID = 'pr-1';
const WS_ID = 'ws-1';

type PrRow = { id: string; workspaceId: string; repoId: string; headSha: string; body: string | null; title: string };

/**
 * Minimal fake `db` supporting the exact chain shapes `IntentService` uses:
 * `select().from(table).where(cond)` — resolves to a table-keyed row array.
 * Table identity is compared by reference against the real schema exports.
 */
function makeDb(opts: { pr: PrRow | undefined; repo?: { id: string; owner: string; name: string }; files?: unknown[] }) {
  const repoRow = opts.repo ?? { id: opts.pr?.repoId ?? 'repo-1', owner: 'acme', name: 'widgets' };
  const files = opts.files ?? [];

  const from = (table: unknown) => ({
    where: async () => {
      if (table === t.pullRequests) return opts.pr ? [opts.pr] : [];
      if (table === t.repos) return [repoRow];
      if (table === t.prFiles) return files;
      throw new Error('unexpected table in test fake db');
    },
  });

  return { select: () => ({ from }) };
}

function makeUpsert() {
  return vi.fn().mockResolvedValue(undefined);
}

/** Builds a Container-shaped object with just what IntentService touches. */
function makeContainer(opts: {
  pr: PrRow | undefined;
  repo?: { id: string; owner: string; name: string };
  files?: unknown[];
}) {
  const jobsRegistered = new Map<string, (payload: unknown) => Promise<void>>();
  const enqueue = vi.fn(async (_ws: string, kind: string, payload: unknown) => {
    const handler = jobsRegistered.get(kind);
    if (handler) await handler(payload);
    return { id: 'job-1', done: Promise.resolve() };
  });

  const published: Array<{ runId: string; kind: RunEventKind; msg: string; data?: unknown }> = [];
  const completed: string[] = [];

  const container = {
    db: makeDb(opts),
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
  } as unknown as Container;

  return { container, enqueue, published, completed };
}

const OK_REFERENCES: CollectedReference[] = [
  {
    kind: 'github_issue',
    id: '#12',
    status: 'ok',
    bodyHash: 'deadbeef',
    bodyChars: 40,
    fetchedAt: '2026-07-04T10:00:00.000Z',
    error: null,
    body: 'Full body of #12',
  },
];

const EXTRACT_RESULT: ExtractIntentResult = {
  dto: {
    goal: 'Add rate limiting.',
    inScope: ['add middleware'],
    outOfScope: [],
    riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
    references: [{ kind: 'github_issue', id: '#12', status: 'ok', bodyChars: 40 }],
    model: 'claude-haiku-4-5-20251001',
    cost: { tokensIn: 100, tokensOut: 50, usd: 0.0009 },
    computedAt: '2026-07-04T10:00:05.000Z',
  },
  tokensIn: 100,
  tokensOut: 50,
  costUsd: 0.0009,
  model: 'claude-haiku-4-5-20251001',
};

describe('IntentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(collectReferences).mockResolvedValue(OK_REFERENCES);
    vi.mocked(extractIntent).mockResolvedValue(EXTRACT_RESULT);
  });

  it('cold path: no cached row returns computing and enqueues exactly once; repo.upsert is called with the correct freshness key after the job runs', async () => {
    const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
    const { container, enqueue } = makeContainer({ pr });
    const service = new IntentService(container);

    const upsert = makeUpsert();
    // Bracket-string access reaches past the `private` modifier for the test double.
    service['repo'].get = vi.fn().mockResolvedValue(null);
    service['repo'].upsert = upsert;

    const result = await service.getOrCompute(WS_ID, PR_ID);

    expect(result.status).toBe('computing');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      PR_ID,
      { headSha: 'sha-1', bodyHash: bodyHashOf('PR body') },
      EXTRACT_RESULT,
      expect.any(Array),
    );
  });

  it('warm path: row matches freshness key returns ready with zero enqueues', async () => {
    const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
    const { container, enqueue } = makeContainer({ pr });
    const service = new IntentService(container);

    service['repo'].get = vi.fn().mockResolvedValue({
      prId: PR_ID,
      headSha: 'sha-1',
      bodyHash: bodyHashOf('PR body'),
      data: EXTRACT_RESULT.dto,
    });

    const result = await service.getOrCompute(WS_ID, PR_ID);

    expect(result).toEqual({ status: 'ready', data: EXTRACT_RESULT.dto });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('drift path: head_sha only / body only / both produce correct staleReasons', async () => {
    const basePr = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', title: 'Add limiter' };

    // head_sha only
    {
      const pr: PrRow = { ...basePr, headSha: 'sha-2', body: 'PR body' };
      const { container } = makeContainer({ pr });
      const service = new IntentService(container);
      service['repo'].get = vi.fn().mockResolvedValue({
        prId: PR_ID,
        headSha: 'sha-1',
        bodyHash: bodyHashOf('PR body'),
        data: EXTRACT_RESULT.dto,
      });
      const result = await service.getOrCompute(WS_ID, PR_ID);
      expect(result).toEqual({ status: 'ready-stale', data: EXTRACT_RESULT.dto, staleReasons: ['head_sha'] });
    }

    // body only
    {
      const pr: PrRow = { ...basePr, headSha: 'sha-1', body: 'PR body v2' };
      const { container } = makeContainer({ pr });
      const service = new IntentService(container);
      service['repo'].get = vi.fn().mockResolvedValue({
        prId: PR_ID,
        headSha: 'sha-1',
        bodyHash: bodyHashOf('PR body'),
        data: EXTRACT_RESULT.dto,
      });
      const result = await service.getOrCompute(WS_ID, PR_ID);
      expect(result).toEqual({ status: 'ready-stale', data: EXTRACT_RESULT.dto, staleReasons: ['body'] });
    }

    // both
    {
      const pr: PrRow = { ...basePr, headSha: 'sha-2', body: 'PR body v2' };
      const { container } = makeContainer({ pr });
      const service = new IntentService(container);
      service['repo'].get = vi.fn().mockResolvedValue({
        prId: PR_ID,
        headSha: 'sha-1',
        bodyHash: bodyHashOf('PR body'),
        data: EXTRACT_RESULT.dto,
      });
      const result = await service.getOrCompute(WS_ID, PR_ID);
      expect(result).toEqual({
        status: 'ready-stale',
        data: EXTRACT_RESULT.dto,
        staleReasons: ['head_sha', 'body'],
      });
    }
  });

  it('refresh always enqueues regardless of freshness match', async () => {
    const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
    const { container, enqueue } = makeContainer({ pr });
    const service = new IntentService(container);
    service['repo'].get = vi.fn().mockResolvedValue({
      prId: PR_ID,
      headSha: 'sha-1',
      bodyHash: bodyHashOf('PR body'),
      data: EXTRACT_RESULT.dto,
    });
    service['repo'].upsert = makeUpsert();

    const result = await service.refresh(WS_ID, PR_ID);

    expect(result.runId).toBeDefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundError when the PR does not exist', async () => {
    const { container } = makeContainer({ pr: undefined });
    const service = new IntentService(container);
    await expect(service.getOrCompute(WS_ID, 'missing-pr')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('rate limits (fake clock)', () => {
    it('a 31st getOrCompute/refresh within the same workspace inside a rolling hour throws RateLimitedError', async () => {
      const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
      const { container } = makeContainer({ pr });
      let clock = 0;
      const service = new IntentService(container, () => clock);
      service['repo'].get = vi.fn().mockResolvedValue(null);
      service['repo'].upsert = makeUpsert();

      // 30 computes at 1-minute intervals — all within the rolling hour.
      for (let i = 0; i < 30; i++) {
        clock += 60_000;
        const result = await service.getOrCompute(WS_ID, PR_ID);
        expect(result.status).toBe('computing');
      }

      // 31st call, still inside the hour window relative to the 1st call.
      clock += 60_000;
      await expect(service.getOrCompute(WS_ID, PR_ID)).rejects.toBeInstanceOf(RateLimitedError);
    });

    it('a 2nd refresh for the same PR within 60s throws RateLimitedError', async () => {
      const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
      const { container } = makeContainer({ pr });
      let clock = 0;
      const service = new IntentService(container, () => clock);
      service['repo'].get = vi.fn().mockResolvedValue({
        prId: PR_ID,
        headSha: 'sha-1',
        bodyHash: bodyHashOf('PR body'),
        data: EXTRACT_RESULT.dto,
      });
      service['repo'].upsert = makeUpsert();

      await service.refresh(WS_ID, PR_ID);
      clock += 30_000; // within the 60s window
      await expect(service.refresh(WS_ID, PR_ID)).rejects.toBeInstanceOf(RateLimitedError);

      clock += 40_000; // now past 60s since the first refresh
      await expect(service.refresh(WS_ID, PR_ID)).resolves.toBeDefined();
    });
  });

  describe('job handler', () => {
    it("publishes 'done' strictly after repo.upsert resolves, and completes the bus in a finally", async () => {
      const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
      const { container, published, completed } = makeContainer({ pr });
      const service = new IntentService(container);

      const order: string[] = [];
      service['repo'].get = vi.fn().mockResolvedValue(null);
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
      expect(completed).toHaveLength(1);
    });

    it("publishes 'error' then still completes the bus when extractIntent throws", async () => {
      const pr: PrRow = { id: PR_ID, workspaceId: WS_ID, repoId: 'repo-1', headSha: 'sha-1', body: 'PR body', title: 'Add limiter' };
      const { container, published, completed } = makeContainer({ pr });
      const service = new IntentService(container);

      service['repo'].get = vi.fn().mockResolvedValue(null);
      const upsert = makeUpsert();
      service['repo'].upsert = upsert;

      vi.mocked(extractIntent).mockRejectedValueOnce(new Error('LLM exploded'));

      await service.getOrCompute(WS_ID, PR_ID);

      expect(upsert).not.toHaveBeenCalled();
      expect(published.some((p) => p.kind === 'error' && p.msg === 'LLM exploded')).toBe(true);
      expect(completed).toHaveLength(1);
    });
  });
});
