import { describe, it, expect } from 'vitest';
import {
  dropUnknownFindingIds,
  capReviewFocus,
  floorRiskLevel,
  buildRisks,
  postprocessBrief,
  REVIEW_FOCUS_CAP,
  type PostprocessFinding,
  type IntentRiskArea,
  type SynthesizedBriefRaw,
} from './postprocess.js';
import type { ReviewFocusItem } from '@devdigest/shared';

function finding(overrides: Partial<PostprocessFinding> & Pick<PostprocessFinding, 'id'>): PostprocessFinding {
  return {
    file: 'src/default.ts',
    startLine: 1,
    severity: 'WARNING',
    category: 'bug',
    ...overrides,
  };
}

describe('dropUnknownFindingIds (AC-7)', () => {
  it('drops a reviewFocus entry whose findingId is not in the input finding set', () => {
    const reviewFocus: ReviewFocusItem[] = [
      { findingId: 'f1', note: 'known' },
      { findingId: 'f-unknown', note: 'model hallucinated this id' },
      { findingId: 'f2', note: 'also known' },
    ];

    const result = dropUnknownFindingIds(reviewFocus, ['f1', 'f2']);

    expect(result).toEqual([
      { findingId: 'f1', note: 'known' },
      { findingId: 'f2', note: 'also known' },
    ]);
  });

  it('accepts a Set of valid ids as well as an array', () => {
    const reviewFocus: ReviewFocusItem[] = [
      { findingId: 'f1', note: 'known' },
      { findingId: 'f-unknown', note: 'gone' },
    ];

    const result = dropUnknownFindingIds(reviewFocus, new Set(['f1']));

    expect(result).toEqual([{ findingId: 'f1', note: 'known' }]);
  });

  it('keeps everything when all ids are valid', () => {
    const reviewFocus: ReviewFocusItem[] = [{ findingId: 'f1', note: 'a' }];
    expect(dropUnknownFindingIds(reviewFocus, ['f1'])).toEqual(reviewFocus);
  });
});

describe('capReviewFocus (AC-9)', () => {
  it('truncates a 12-entry list to 8, preserving the model order (index 0 = read first)', () => {
    const reviewFocus: ReviewFocusItem[] = Array.from({ length: 12 }, (_, i) => ({
      findingId: `f${i}`,
      note: `note ${i}`,
    }));

    const result = capReviewFocus(reviewFocus);

    expect(result).toHaveLength(REVIEW_FOCUS_CAP);
    expect(result.map((r) => r.findingId)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']);
  });

  it('leaves a list at or under the cap untouched', () => {
    const reviewFocus: ReviewFocusItem[] = Array.from({ length: 5 }, (_, i) => ({
      findingId: `f${i}`,
      note: `note ${i}`,
    }));
    expect(capReviewFocus(reviewFocus)).toEqual(reviewFocus);
  });
});

describe('floorRiskLevel (AC-14, AC-15)', () => {
  it('AC-14: a real CRITICAL finding floors a lower model riskLevel of "low" to "high"', () => {
    const findings = [finding({ id: 'f1', severity: 'CRITICAL' })];
    expect(floorRiskLevel('low', findings)).toBe('high');
  });

  it('AC-14: a real CRITICAL finding floors a "medium" model riskLevel to "high"', () => {
    const findings = [finding({ id: 'f1', severity: 'CRITICAL' })];
    expect(floorRiskLevel('medium', findings)).toBe('high');
  });

  it('AC-14: never lowers a model riskLevel already at "high"', () => {
    const findings = [finding({ id: 'f1', severity: 'CRITICAL' })];
    expect(floorRiskLevel('high', findings)).toBe('high');
  });

  it('AC-15: with only WARNING/SUGGESTION findings, the model riskLevel is preserved verbatim', () => {
    const findings = [
      finding({ id: 'f1', severity: 'WARNING' }),
      finding({ id: 'f2', severity: 'SUGGESTION' }),
    ];
    expect(floorRiskLevel('low', findings)).toBe('low');
    expect(floorRiskLevel('medium', findings)).toBe('medium');
    expect(floorRiskLevel('high', findings)).toBe('high');
  });

  it('AC-15: an empty finding set never raises the floor', () => {
    expect(floorRiskLevel('low', [])).toBe('low');
  });

  it('matches case-insensitively, mirroring aggregate.ts BLOCKER_SEVERITIES semantics', () => {
    const findings = [finding({ id: 'f1', severity: 'critical' })];
    expect(floorRiskLevel('low', findings)).toBe('high');
  });
});

describe('buildRisks (AC-3, AC-4)', () => {
  it('AC-3: reproduces intent.riskAreas verbatim by value (icon/label unchanged, not re-derived)', () => {
    const riskAreas: IntentRiskArea[] = [
      { icon: 'shield', label: 'Auth flow' },
      { icon: 'database', label: 'Schema migration' },
    ];

    const result = buildRisks(riskAreas, []);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ icon: 'shield', label: 'Auth flow' });
    expect(result[1]).toMatchObject({ icon: 'database', label: 'Schema migration' });
  });

  it('AC-4: a risk area with no matching finding yields fileRef: undefined (never fabricated)', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];
    const findings = [finding({ id: 'f1', file: 'src/billing/invoice.ts', category: 'perf' })];

    const result = buildRisks(riskAreas, findings);

    expect(result).toEqual([{ icon: 'shield', label: 'Auth flow' }]);
    expect(result[0]!.fileRef).toBeUndefined();
  });

  it('AC-4: an empty finding set yields fileRef: undefined for every risk area', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'zap', label: 'Perf' }];
    expect(buildRisks(riskAreas, [])[0]!.fileRef).toBeUndefined();
  });

  it('attaches fileRef when a finding path token-matches the risk-area label', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];
    const findings = [
      finding({ id: 'f1', file: 'src/auth/session.ts', startLine: 42, severity: 'WARNING' }),
    ];

    const result = buildRisks(riskAreas, findings);

    expect(result[0]!.fileRef).toEqual({ file: 'src/auth/session.ts', line: 42 });
  });

  it('matches on category when the file path does not contain the label token', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Security' }];
    const findings = [
      finding({ id: 'f1', file: 'src/handlers/upload.ts', category: 'security', startLine: 7 }),
    ];

    const result = buildRisks(riskAreas, findings);

    expect(result[0]!.fileRef).toEqual({ file: 'src/handlers/upload.ts', line: 7 });
  });

  it('prefers the highest-severity match when several findings match the same risk area', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];
    const findings = [
      finding({ id: 'f1', file: 'src/auth/low.ts', startLine: 1, severity: 'SUGGESTION' }),
      finding({ id: 'f2', file: 'src/auth/high.ts', startLine: 2, severity: 'CRITICAL' }),
      finding({ id: 'f3', file: 'src/auth/mid.ts', startLine: 3, severity: 'WARNING' }),
    ];

    const result = buildRisks(riskAreas, findings);

    expect(result[0]!.fileRef).toEqual({ file: 'src/auth/high.ts', line: 2 });
  });

  it('excludes dismissed findings from fileRef matching, even if unfiltered upstream', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];
    const findings = [
      finding({
        id: 'f1',
        file: 'src/auth/dismissed.ts',
        startLine: 5,
        severity: 'CRITICAL',
        dismissedAt: '2026-07-01T00:00:00.000Z',
      }),
    ];

    const result = buildRisks(riskAreas, findings);

    expect(result[0]!.fileRef).toBeUndefined();
  });

  it('omits fileRef when the top-severity tier is ambiguous across distinct locations', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];
    const findings = [
      finding({ id: 'f1', file: 'src/auth/a.ts', startLine: 1, severity: 'CRITICAL' }),
      finding({ id: 'f2', file: 'src/auth/b.ts', startLine: 2, severity: 'CRITICAL' }),
    ];

    const result = buildRisks(riskAreas, findings);

    expect(result[0]!.fileRef).toBeUndefined();
  });

  it('does not treat duplicate findings at the identical top-tier location as ambiguous', () => {
    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];
    const findings = [
      finding({ id: 'f1', file: 'src/auth/same.ts', startLine: 9, severity: 'CRITICAL' }),
      finding({ id: 'f2', file: 'src/auth/same.ts', startLine: 9, severity: 'CRITICAL' }),
    ];

    const result = buildRisks(riskAreas, findings);

    expect(result[0]!.fileRef).toEqual({ file: 'src/auth/same.ts', line: 9 });
  });
});

describe('postprocessBrief (composed pipeline)', () => {
  it('applies drop -> cap -> floor -> risks in order', () => {
    const raw: SynthesizedBriefRaw = {
      what: 'Adds OAuth refresh handling',
      why: 'Token refresh was failing silently under load',
      riskLevel: 'low',
      reviewFocus: [
        { findingId: 'f1', note: 'check refresh retry' },
        { findingId: 'f-unknown', note: 'hallucinated' },
        { findingId: 'f2', note: 'check token storage' },
        { findingId: 'f3', note: '3' },
        { findingId: 'f4', note: '4' },
        { findingId: 'f5', note: '5' },
        { findingId: 'f6', note: '6' },
        { findingId: 'f7', note: '7' },
        { findingId: 'f8', note: '8' },
        { findingId: 'f9', note: '9' },
      ],
    };

    const findings: PostprocessFinding[] = [
      finding({ id: 'f1', file: 'src/auth/refresh.ts', startLine: 12, severity: 'CRITICAL' }),
      finding({ id: 'f2', file: 'src/auth/storage.ts', startLine: 4, severity: 'WARNING' }),
      finding({ id: 'f3', severity: 'WARNING' }),
      finding({ id: 'f4', severity: 'WARNING' }),
      finding({ id: 'f5', severity: 'WARNING' }),
      finding({ id: 'f6', severity: 'WARNING' }),
      finding({ id: 'f7', severity: 'WARNING' }),
      finding({ id: 'f8', severity: 'WARNING' }),
      finding({ id: 'f9', severity: 'WARNING' }),
    ];

    const riskAreas: IntentRiskArea[] = [{ icon: 'shield', label: 'Auth flow' }];

    const result = postprocessBrief(raw, { findings, riskAreas });

    // AC-7: unknown id dropped before the cap is applied.
    expect(result.reviewFocus.some((r) => r.findingId === 'f-unknown')).toBe(false);
    // AC-9: capped at 8, order preserved (f-unknown's removal shifts f9 out, not f8).
    expect(result.reviewFocus).toHaveLength(8);
    expect(result.reviewFocus.map((r) => r.findingId)).toEqual([
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7',
      'f8',
    ]);
    // AC-14: a real CRITICAL finding floors riskLevel 'low' -> 'high'.
    expect(result.riskLevel).toBe('high');
    // AC-3/AC-4: risks[] verbatim with a server-attached fileRef from the highest-severity match.
    expect(result.risks).toEqual([
      { icon: 'shield', label: 'Auth flow', fileRef: { file: 'src/auth/refresh.ts', line: 12 } },
    ]);
    expect(result.what).toBe(raw.what);
    expect(result.why).toBe(raw.why);
  });
});
