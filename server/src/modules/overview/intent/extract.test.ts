import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractIntent } from './extract.js';
import type { Container } from '../../../platform/container.js';
import type { CollectedReference } from './types.js';

vi.mock('../../../platform/prompts.js', () => ({
  loadPromptTemplate: vi.fn().mockResolvedValue('You restate PR intent.'),
}));

interface LlmCall {
  model: string;
  schemaName?: string;
  messages: Array<{ role: string; content: string }>;
  maxRetries?: number;
}

function makeContainer(payload: unknown, calls: LlmCall[] = []): Partial<Container> {
  const completeStructured = vi.fn(async (args: LlmCall) => {
    calls.push(args);
    return {
      data: payload,
      model: 'claude-haiku-4-5-20251001',
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.0009,
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

const OK_REF: CollectedReference = {
  kind: 'github_issue',
  id: '#12',
  status: 'ok',
  bodyHash: 'deadbeef',
  bodyChars: 120,
  fetchedAt: '2026-07-04T10:00:00.000Z',
  error: null,
  body: 'Full issue body of #12',
};

const NOT_FOUND_REF: CollectedReference = {
  kind: 'github_issue',
  id: '#99',
  status: 'not_found',
  bodyHash: null,
  bodyChars: 0,
  fetchedAt: '2026-07-04T10:00:00.000Z',
  error: 'Not Found',
  body: null,
};

const VALID_PAYLOAD = {
  goal: 'Add rate limiting to the public API.',
  inScope: ['add middleware', 'cover REST routes'],
  outOfScope: ['DB schema change'],
  riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
};

describe('extractIntent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assembles a PrIntentDto from a valid LLM payload; cost/model come from the wrapper, references pass through unchanged', async () => {
    const container = makeContainer(VALID_PAYLOAD);
    const result = await extractIntent(container as Container, 'ws-1', {
      title: 'Rate limit public API',
      body: 'Adds a sliding-window limiter.',
      diffSummary: '--- src/api/limiter.ts (+80/-0) ---\n// patch',
      references: [OK_REF, NOT_FOUND_REF],
    });

    expect(result.dto.goal).toMatch(/rate limit/i);
    expect(result.dto.riskAreas).toHaveLength(1);
    expect(result.dto.riskAreas[0]!.icon).toBe('shield');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.tokensIn).toBe(100);
    expect(result.costUsd).toBeCloseTo(0.0009, 6);
    // References survive the round-trip but are stripped to the wire shape
    // (bodyHash/error/body are dropped by PrIntentDto's Zod schema).
    expect(result.dto.references).toHaveLength(2);
    expect(result.dto.references[0]).toEqual({
      kind: 'github_issue',
      id: '#12',
      status: 'ok',
      bodyChars: 120,
    });
    expect(result.dto.references[1]).toEqual({
      kind: 'github_issue',
      id: '#99',
      status: 'not_found',
      bodyChars: 0,
    });
    expect(result.dto.computedAt).toBeDefined();
  });

  it('rejects when the LLM returns an invalid risk icon (defensive re-parse catches it)', async () => {
    const container = makeContainer({
      goal: 'x',
      inScope: [],
      outOfScope: [],
      riskAreas: [{ icon: 'rocket', label: 'no' }],
    });
    await expect(
      extractIntent(container as Container, 'ws-1', {
        title: 't',
        body: '',
        diffSummary: '(no files)',
        references: [],
      }),
    ).rejects.toThrow();
  });

  it('inlines only status:ok references inside <external_reference> blocks; skips others', async () => {
    const calls: LlmCall[] = [];
    const container = makeContainer(VALID_PAYLOAD, calls);
    await extractIntent(container as Container, 'ws-1', {
      title: 't',
      body: 'b',
      diffSummary: '(no files)',
      references: [OK_REF, NOT_FOUND_REF],
    });

    expect(calls).toHaveLength(1);
    const userMessage = calls[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(userMessage).toContain('<external_reference kind="github_issue" id="#12"');
    expect(userMessage).toContain('Full issue body of #12');
    expect(userMessage).not.toContain('#99');
  });
});
