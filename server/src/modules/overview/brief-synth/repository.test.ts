import { describe, it, expect } from 'vitest';
import type { Db } from '../../../db/client.js';
import { BriefSynthRepository } from './repository.js';
import type { BriefSynthUpsertResult, BriefSynthUpsertKey } from './repository.js';

const PR_ID = 'pr-1';

/**
 * Minimal fake `db` supporting the `select().from(table).where(cond)` chain
 * `BriefSynthRepository.get()` uses. Mirrors the fake in
 * `overview/intent/service.test.ts` -- table identity/condition aren't
 * inspected, only the resolved row array matters here.
 */
function makeSelectDb(row: Record<string, unknown> | undefined): Db {
  const select = () => ({
    from: () => ({
      where: async () => (row ? [row] : []),
    }),
  });
  return { select } as unknown as Db;
}

/**
 * Fake `db` capturing every `insert(table).values(vals).onConflictDoUpdate(opts)`
 * call `BriefSynthRepository.upsert()` makes, so the `set` clause can be
 * asserted structurally without a live Postgres connection (L4 -- unit scope
 * has no Docker; real on-conflict overwrite behavior is proven by T9's
 * integration AC-36 two-refresh case).
 */
function makeInsertCapturingDb() {
  const calls: Array<{
    values: Record<string, unknown>;
    target: unknown;
    set: Record<string, unknown>;
  }> = [];

  const insert = () => ({
    values: (vals: Record<string, unknown>) => ({
      onConflictDoUpdate: async (opts: { target: unknown; set: Record<string, unknown> }) => {
        calls.push({ values: vals, target: opts.target, set: opts.set });
      },
    }),
  });

  return { db: { insert } as unknown as Db, calls };
}

const FULL_ROW = {
  prId: PR_ID,
  json: {
    what: 'Adds rate limiting to the brief-synth refresh endpoint.',
    why: 'Prevent runaway LLM spend under client retry storms.',
    risks: [
      { icon: 'shield', label: 'auth middleware', fileRef: { file: 'src/auth.ts', line: 42 } },
    ],
    reviewFocus: [{ findingId: 'finding-1', note: 'Missing rate-limit regression test.' }],
  },
  headSha: 'sha-abc',
  reviewId: 'review-1',
  intentComputedAt: new Date('2026-07-10T11:00:00.000Z'),
  riskLevel: 'high',
  model: 'claude-haiku-4-5-20251001',
  promptTokens: 8200,
  completionTokens: 1300,
  costUsd: '0.014000',
  computedAt: new Date('2026-07-10T12:00:00.000Z'),
};

describe('BriefSynthRepository.get', () => {
  it('returns null when no cached row exists', async () => {
    const repo = new BriefSynthRepository(makeSelectDb(undefined));
    expect(await repo.get(PR_ID)).toBeNull();
  });

  it('returns null for a null-model ghost row (pre-existing pr_brief row, defensive cache-miss guard)', async () => {
    const repo = new BriefSynthRepository(makeSelectDb({ ...FULL_ROW, model: null }));
    expect(await repo.get(PR_ID)).toBeNull();
  });

  it('maps a full row to { data, basedOn } with a non-null reviewId', async () => {
    const repo = new BriefSynthRepository(makeSelectDb(FULL_ROW));
    const result = await repo.get(PR_ID);

    expect(result).not.toBeNull();
    expect(result!.prId).toBe(PR_ID);
    expect(result!.data).toEqual({
      what: FULL_ROW.json.what,
      why: FULL_ROW.json.why,
      riskLevel: 'high',
      risks: FULL_ROW.json.risks,
      reviewFocus: FULL_ROW.json.reviewFocus,
      model: FULL_ROW.model,
      cost: { tokensIn: 8200, tokensOut: 1300, usd: 0.014 },
      computedAt: FULL_ROW.computedAt.toISOString(),
    });
    expect(result!.basedOn).toEqual({
      headSha: 'sha-abc',
      reviewId: 'review-1',
      intentComputedAt: FULL_ROW.intentComputedAt.toISOString(),
    });
  });

  it('handles a null reviewId (review deleted after the brief was cached -- L1) without throwing', async () => {
    const repo = new BriefSynthRepository(makeSelectDb({ ...FULL_ROW, reviewId: null }));
    const result = await repo.get(PR_ID);

    expect(result).not.toBeNull();
    expect(result!.basedOn.reviewId).toBeNull();
    // The rest of the mapping is unaffected by the deleted review.
    expect(result!.data.what).toBe(FULL_ROW.json.what);
    expect(result!.basedOn.headSha).toBe('sha-abc');
  });
});

const KEY_A: BriefSynthUpsertKey = {
  headSha: 'sha-a',
  reviewId: 'review-a',
  intentComputedAt: '2026-07-10T10:00:00.000Z',
};

const RESULT_A: BriefSynthUpsertResult = {
  dto: {
    what: 'What A.',
    why: 'Why A.',
    riskLevel: 'low',
    risks: [{ icon: 'shield', label: 'auth' }],
    reviewFocus: [{ findingId: 'finding-a', note: 'Note A.' }],
  },
  tokensIn: 100,
  tokensOut: 50,
  costUsd: 0.001,
  model: 'model-a',
};

const KEY_B: BriefSynthUpsertKey = {
  headSha: 'sha-b',
  reviewId: 'review-b',
  intentComputedAt: '2026-07-11T10:00:00.000Z',
};

const RESULT_B: BriefSynthUpsertResult = {
  dto: {
    what: 'What B.',
    why: 'Why B.',
    riskLevel: 'high',
    risks: [{ icon: 'database', label: 'schema migration' }],
    reviewFocus: [{ findingId: 'finding-b', note: 'Note B.' }],
  },
  tokensIn: 9000,
  tokensOut: 1400,
  costUsd: 0.02,
  model: 'model-b',
};

/**
 * Every column the `pr_brief` table persists (0000_init.sql's `json` plus
 * 0017_extend_pr_brief.sql's freshness/cost columns), minus `prId` -- the
 * conflict target, not part of `set`. Hardcoded (not derived from the
 * repository's own `values` object) so this test fails if `repository.ts`'s
 * `set` clause AND its `values` object drift together (e.g. a copy-paste
 * that never wires a new column into either).
 */
const PERSISTED_COLUMNS = [
  'json',
  'headSha',
  'reviewId',
  'intentComputedAt',
  'riskLevel',
  'model',
  'promptTokens',
  'completionTokens',
  'costUsd',
  'computedAt',
].sort();

describe('BriefSynthRepository.upsert (AC-38: set-clause completeness)', () => {
  it('the set clause lists every persisted column (structural completeness, no Postgres in unit scope)', async () => {
    const { db, calls } = makeInsertCapturingDb();
    const repo = new BriefSynthRepository(db);

    await repo.upsert(PR_ID, KEY_A, RESULT_A);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected exactly one captured upsert call');
    const { set, values } = call;

    expect(Object.keys(set).sort()).toEqual(PERSISTED_COLUMNS);
    expect(Object.keys(values).sort()).toEqual([...PERSISTED_COLUMNS, 'prId'].sort());
  });

  it('a second upsert with different values overwrites every column -- no stale carry-over from the first', async () => {
    const { db, calls } = makeInsertCapturingDb();
    const repo = new BriefSynthRepository(db);

    await repo.upsert(PR_ID, KEY_A, RESULT_A);
    await repo.upsert(PR_ID, KEY_B, RESULT_B);

    expect(calls).toHaveLength(2);
    const secondCall = calls[1];
    if (!secondCall) throw new Error('expected exactly two captured upsert calls');
    const second = secondCall.set;

    // Every persisted column is still present on the second call's `set`.
    expect(Object.keys(second).sort()).toEqual(PERSISTED_COLUMNS);

    // The second call's `set` carries call B's values -- not call A's.
    expect(second.json).toEqual({
      what: RESULT_B.dto.what,
      why: RESULT_B.dto.why,
      risks: RESULT_B.dto.risks,
      reviewFocus: RESULT_B.dto.reviewFocus,
    });
    expect(second.headSha).toBe(KEY_B.headSha);
    expect(second.reviewId).toBe(KEY_B.reviewId);
    expect(second.intentComputedAt).toEqual(new Date(KEY_B.intentComputedAt));
    expect(second.riskLevel).toBe(RESULT_B.dto.riskLevel);
    expect(second.model).toBe(RESULT_B.model);
    expect(second.promptTokens).toBe(RESULT_B.tokensIn);
    expect(second.completionTokens).toBe(RESULT_B.tokensOut);
    expect(second.costUsd).toBe(RESULT_B.costUsd.toFixed(6));
    expect(second.computedAt).toBeInstanceOf(Date);

    // Structural "no stale column" proof: none of call B's persisted values
    // equal call A's inputs for the same column (see server/INSIGHTS.md
    // 2026-06-23 `linkSkill` -- an omitted `set` field silently preserves
    // the prior row's value on conflict; here every field visibly changed).
    expect(second.headSha).not.toBe(KEY_A.headSha);
    expect(second.reviewId).not.toBe(KEY_A.reviewId);
    expect(second.riskLevel).not.toBe(RESULT_A.dto.riskLevel);
    expect(second.model).not.toBe(RESULT_A.model);
    expect(second.promptTokens).not.toBe(RESULT_A.tokensIn);
    expect(second.completionTokens).not.toBe(RESULT_A.tokensOut);
    expect(second.costUsd).not.toBe(RESULT_A.costUsd.toFixed(6));
  });
});
