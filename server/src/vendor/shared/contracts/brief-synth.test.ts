import { describe, it, expect } from 'vitest';
import {
  PrWhyRiskBrief,
  PrWhyRiskBriefResponse,
  ReviewFocusItem,
  RiskArea,
} from './brief-synth.js';

const validBrief: PrWhyRiskBrief = {
  what: 'Adds a synthesized why/risk brief to the Overview tab.',
  why: 'Reviewers currently re-read the raw diff to get a one-sentence summary.',
  riskLevel: 'high',
  risks: [
    {
      icon: 'shield',
      label: 'Prompt injection',
      fileRef: { file: 'server/src/modules/overview/brief-synth/synthesize.ts', line: 42 },
    },
    { icon: 'database', label: 'Migration risk' },
  ],
  reviewFocus: [
    { findingId: 'finding-1', note: 'Missing input validation on the new endpoint.' },
    { findingId: 'finding-2', note: 'Unbounded loop over findings.' },
  ],
  model: 'anthropic/claude-sonnet-5',
  cost: { tokensIn: 5400, tokensOut: 620, usd: 0.0134 },
  computedAt: '2026-07-13T12:00:00.000Z',
  basedOn: {
    headSha: 'abc123',
    reviewId: '11111111-1111-1111-1111-111111111111',
    intentComputedAt: '2026-07-13T11:00:00.000Z',
  },
};

describe('PrWhyRiskBrief', () => {
  it('accepts a full valid payload covering every named field, incl. nested cost/basedOn (AC-1)', () => {
    const result = PrWhyRiskBrief.safeParse(validBrief);
    expect(result.success).toBe(true);
  });

  it('accepts a risk area with no fileRef (AC-4: omitted rather than fabricated)', () => {
    const result = RiskArea.safeParse({ icon: 'zap', label: 'No match' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown RiskAreaIcon value', () => {
    const result = RiskArea.safeParse({ icon: 'not-a-real-icon', label: 'Bad icon' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown riskLevel value (must reuse RiskSeverity)', () => {
    const result = PrWhyRiskBrief.safeParse({ ...validBrief, riskLevel: 'blocker' });
    expect(result.success).toBe(false);
  });
});

describe('ReviewFocusItem (AC-2: findingId + note only, never file/line)', () => {
  it('accepts a valid { findingId, note } entry', () => {
    const result = ReviewFocusItem.safeParse({ findingId: 'finding-1', note: 'Check this first.' });
    expect(result.success).toBe(true);
  });

  it('throws on .parse() when an entry carries an extra file key (strict rejection, not silent stripping)', () => {
    const withFile = { findingId: 'finding-1', note: 'Check this first.', file: 'src/index.ts' };
    expect(() => ReviewFocusItem.parse(withFile)).toThrow();
    // Prove it's rejection, not stripping: safeParse must also fail (a stripped
    // result would report success: true with `file` silently dropped).
    expect(ReviewFocusItem.safeParse(withFile).success).toBe(false);
  });

  it('throws on .parse() when an entry carries an extra line key (strict rejection, not silent stripping)', () => {
    const withLine = { findingId: 'finding-1', note: 'Check this first.', line: 42 };
    expect(() => ReviewFocusItem.parse(withLine)).toThrow();
    expect(ReviewFocusItem.safeParse(withLine).success).toBe(false);
  });
});

describe('PrWhyRiskBriefResponse', () => {
  it('accepts a ready response', () => {
    const result = PrWhyRiskBriefResponse.safeParse({ status: 'ready', data: validBrief });
    expect(result.success).toBe(true);
  });

  it('accepts a ready-stale response with at least one staleReason', () => {
    const result = PrWhyRiskBriefResponse.safeParse({
      status: 'ready-stale',
      data: validBrief,
      staleReasons: ['head_sha', 'new_review'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ready-stale response with an empty staleReasons array', () => {
    const result = PrWhyRiskBriefResponse.safeParse({
      status: 'ready-stale',
      data: validBrief,
      staleReasons: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a not_ready response naming missing intent/review', () => {
    const result = PrWhyRiskBriefResponse.safeParse({
      status: 'not_ready',
      missing: ['intent', 'review'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a not_ready response with an empty missing array', () => {
    const result = PrWhyRiskBriefResponse.safeParse({ status: 'not_ready', missing: [] });
    expect(result.success).toBe(false);
  });

  it('accepts a computing response', () => {
    const result = PrWhyRiskBriefResponse.safeParse({ status: 'computing', runId: 'run-123' });
    expect(result.success).toBe(true);
  });

  it('accepts an error response', () => {
    const result = PrWhyRiskBriefResponse.safeParse({ status: 'error', message: 'boom' });
    expect(result.success).toBe(true);
  });
});
