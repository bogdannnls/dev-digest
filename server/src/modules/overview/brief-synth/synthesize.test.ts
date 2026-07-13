import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeBrief } from './synthesize.js';
import type { Container } from '../../../platform/container.js';
import type { BriefSynthInput } from './assemble-input.js';

vi.mock('../../../platform/prompts.js', () => ({
  loadPromptTemplate: vi.fn().mockResolvedValue('You synthesize a why + risk brief.'),
}));

import { loadPromptTemplate } from '../../../platform/prompts.js';

interface LlmCall {
  model: string;
  schemaName?: string;
  schema: { parse: (v: unknown) => unknown };
  messages: Array<{ role: string; content: string }>;
  maxRetries?: number;
}

function makeContainer(payload: unknown, calls: LlmCall[] = []): Partial<Container> {
  const completeStructured = vi.fn(async (args: LlmCall) => {
    calls.push(args);
    return {
      data: args.schema.parse(payload),
      model: 'claude-haiku-4-5-20251001',
      tokensIn: 200,
      tokensOut: 80,
      costUsd: 0.0012,
      raw: JSON.stringify(payload),
      attempts: 1,
    };
  });
  return {
    resolveFeatureModel: vi
      .fn()
      .mockResolvedValue({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
    llm: vi.fn().mockResolvedValue({ completeStructured }),
  } as unknown as Partial<Container>;
}

const INPUT: BriefSynthInput = {
  basedOn: {
    headSha: 'abc123',
    reviewId: 'review-1',
    intentComputedAt: '2026-07-10T00:00:00.000Z',
  },
  intent: {
    goal: 'Add rate limiting to the public API.',
    inScope: ['add middleware'],
    outOfScope: ['DB schema change'],
    riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
    references: [],
  },
  findings: [
    {
      id: 'finding-1',
      file: 'src/api/limiter.ts',
      startLine: 10,
      endLine: 20,
      severity: 'CRITICAL',
      category: 'security',
      title: 'Missing auth check',
      rationale: 'The limiter bypasses auth on the fallback path.',
    },
  ],
  blast: {
    changedSymbols: [{ file: 'src/api/limiter.ts', name: 'RateLimiter', kind: 'class' }],
    callers: [
      { file: 'src/api/routes.ts', symbol: 'handleRequest', viaSymbol: 'RateLimiter', line: 42, rank: 3 },
    ],
    impactedEndpoints: ['POST /api/limit'],
  },
  diffStats: {
    groups: [
      {
        role: 'core',
        files: [{ path: 'src/api/limiter.ts', pseudocode_summary: null, additions: 80, deletions: 0, finding_lines: [10] }],
      },
    ],
    split_suggestion: { too_big: false, total_lines: 80, proposed_splits: [] },
  },
  attachedSpecs: [{ path: 'docs/rate-limiting.md', title: 'rate-limiting.md' }],
};

const VALID_PAYLOAD = {
  what: 'Adds a sliding-window rate limiter to the public API.',
  why: 'Prevents abuse of unauthenticated endpoints, per the intent goal.',
  riskLevel: 'medium',
  reviewFocus: [{ findingId: 'finding-1', note: 'Auth bypass on the fallback path.' }],
};

describe('synthesizeBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls completeStructured exactly once and returns the parsed payload plus token/cost usage', async () => {
    const calls: LlmCall[] = [];
    const container = makeContainer(VALID_PAYLOAD, calls);

    const result = await synthesizeBrief(container as Container, 'ws-1', INPUT);

    expect(calls).toHaveLength(1);
    expect(result.data.what).toBe(VALID_PAYLOAD.what);
    expect(result.data.why).toBe(VALID_PAYLOAD.why);
    expect(result.data.riskLevel).toBe('medium');
    expect(result.data.reviewFocus).toEqual(VALID_PAYLOAD.reviewFocus);
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.tokensIn).toBe(200);
    expect(result.tokensOut).toBe(80);
    expect(result.costUsd).toBeCloseTo(0.0012, 6);
  });

  it('resolves the model via resolveFeatureModel with the risk_brief feature id (AC-35)', async () => {
    const container = makeContainer(VALID_PAYLOAD);

    await synthesizeBrief(container as Container, 'ws-42', INPUT);

    expect(container.resolveFeatureModel).toHaveBeenCalledTimes(1);
    expect(container.resolveFeatureModel).toHaveBeenCalledWith('ws-42', 'risk_brief');
  });

  it('loads brief-synth.system.md — a prompt file distinct from Intent\'s (AC-13)', async () => {
    const container = makeContainer(VALID_PAYLOAD);

    await synthesizeBrief(container as Container, 'ws-1', INPUT);

    expect(loadPromptTemplate).toHaveBeenCalledTimes(1);
    expect(loadPromptTemplate).toHaveBeenCalledWith('brief-synth.system.md');
    expect(loadPromptTemplate).not.toHaveBeenCalledWith('intent-extractor.system.md');
  });

  it('never emits a risks[] field — the payload schema does not accept/emit one', async () => {
    const calls: LlmCall[] = [];
    const container = makeContainer(
      { ...VALID_PAYLOAD, risks: [{ icon: 'shield', label: 'auth middleware', fileRef: { file: 'x.ts', line: 1 } }] },
      calls,
    );

    const result = await synthesizeBrief(container as Container, 'ws-1', INPUT);

    expect(result.data).not.toHaveProperty('risks');
    expect(Object.keys(result.data).sort()).toEqual(['reviewFocus', 'riskLevel', 'what', 'why']);
    // The schema handed to completeStructured is the boundary that strips it —
    // assert the same behavior directly against that schema instance.
    const schema = calls[0]!.schema;
    const parsed = schema.parse({
      ...VALID_PAYLOAD,
      risks: [{ icon: 'shield', label: 'auth middleware' }],
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('risks');
  });

  it('rejects when the model returns an invalid riskLevel (defensive re-parse catches it)', async () => {
    const container = makeContainer({ ...VALID_PAYLOAD, riskLevel: 'critical' });

    await expect(synthesizeBrief(container as Container, 'ws-1', INPUT)).rejects.toThrow();
  });

  it('rejects when a reviewFocus entry carries an extra key (ReviewFocusItem is .strict())', async () => {
    const container = makeContainer({
      ...VALID_PAYLOAD,
      reviewFocus: [{ findingId: 'finding-1', note: 'x', file: 'src/api/limiter.ts', line: 10 }],
    });

    await expect(synthesizeBrief(container as Container, 'ws-1', INPUT)).rejects.toThrow();
  });

  it('builds a user message that includes finding ids, intent goal, and attached-spec titles', async () => {
    const calls: LlmCall[] = [];
    const container = makeContainer(VALID_PAYLOAD, calls);

    await synthesizeBrief(container as Container, 'ws-1', INPUT);

    const userMessage = calls[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(userMessage).toContain('finding-1');
    expect(userMessage).toContain(INPUT.intent.goal);
    expect(userMessage).toContain('rate-limiting.md');
    // No diff/patch body content is ever assembled by T3 into this input, so
    // none can leak into the message either — nothing to assert missing here
    // beyond what assemble-input.test.ts already covers (AC-5/AC-6 are T3's).
  });
});
