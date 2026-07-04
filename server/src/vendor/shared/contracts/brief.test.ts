import { describe, it, expect } from 'vitest';
import {
  IntentReferenceDto,
  IntentReferenceKind,
  IntentReferenceStatus,
  PrIntentDto,
  PrIntentResponse,
  RiskAreaIcon,
} from './brief.js';

const validReference: IntentReferenceDto = {
  kind: 'github_issue',
  id: '42',
  status: 'ok',
  bodyChars: 1234,
};

const validIntentPayload: PrIntentDto = {
  goal: 'Ship a read-through cached IntentCard on the PR Overview tab.',
  inScope: ['Migration', 'Extractor', 'Routes'],
  outOfScope: ['Jira/Linear adapters', 'URL fetcher'],
  riskAreas: [{ icon: 'shield', label: 'Prompt injection' }],
  references: [validReference],
  model: 'anthropic/claude-haiku-4-5-20251001',
  cost: { tokensIn: 1200, tokensOut: 340, usd: 0.0021 },
  computedAt: '2026-07-04T12:00:00.000Z',
};

describe('IntentReferenceKind / IntentReferenceStatus enums', () => {
  it('accepts all 4 reference kinds (github_issue/jira/linear/url)', () => {
    for (const kind of ['github_issue', 'jira', 'linear', 'url']) {
      expect(IntentReferenceKind.safeParse(kind).success).toBe(true);
    }
  });

  it('accepts all 8 reference statuses', () => {
    const statuses = [
      'ok',
      'not_allowlisted',
      'no_auth',
      'unreachable',
      'timeout',
      'too_large',
      'not_found',
      'parse_error',
    ];
    for (const status of statuses) {
      expect(IntentReferenceStatus.safeParse(status).success).toBe(true);
    }
  });
});

describe('PrIntentDto', () => {
  it('accepts a full valid payload', () => {
    const result = PrIntentDto.safeParse(validIntentPayload);
    expect(result.success).toBe(true);
  });

  it('rejects an unknown RiskAreaIcon value', () => {
    const result = PrIntentDto.safeParse({
      ...validIntentPayload,
      riskAreas: [{ icon: 'not-a-real-icon', label: 'Bad icon' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown IntentReferenceStatus value', () => {
    const result = PrIntentDto.safeParse({
      ...validIntentPayload,
      references: [{ ...validReference, status: 'not-a-real-status' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('RiskAreaIcon', () => {
  it('accepts all 5 documented icons', () => {
    for (const icon of ['shield', 'package', 'zap', 'database', 'globe']) {
      expect(RiskAreaIcon.safeParse(icon).success).toBe(true);
    }
  });
});

describe('PrIntentResponse', () => {
  it('accepts a ready-stale response with at least one staleReason', () => {
    const result = PrIntentResponse.safeParse({
      status: 'ready-stale',
      data: validIntentPayload,
      staleReasons: ['head_sha'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ready-stale response with an empty staleReasons array', () => {
    const result = PrIntentResponse.safeParse({
      status: 'ready-stale',
      data: validIntentPayload,
      staleReasons: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a ready response', () => {
    const result = PrIntentResponse.safeParse({ status: 'ready', data: validIntentPayload });
    expect(result.success).toBe(true);
  });

  it('accepts a computing response', () => {
    const result = PrIntentResponse.safeParse({ status: 'computing', runId: 'run-123' });
    expect(result.success).toBe(true);
  });

  it('accepts an error response', () => {
    const result = PrIntentResponse.safeParse({ status: 'error', message: 'boom' });
    expect(result.success).toBe(true);
  });
});
