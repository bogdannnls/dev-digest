import { describe, it, expect } from 'vitest';
import { aggregatePrBrief } from './aggregate.js';

const now = new Date('2026-06-24T12:00:00Z');

describe('aggregatePrBrief', () => {
  it('returns no_runs when there are no reviews', () => {
    const out = aggregatePrBrief({ reviews: [], findings: [], runCosts: [], now });
    expect(out).toEqual({ status: 'no_runs' });
  });

  it('picks worst verdict (request_changes > comment > approve)', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'approve', summary: 'a', score: 90, createdAt: new Date('2026-06-24T10:00:00Z') },
        { id: 'r2', runId: 'run2', verdict: 'request_changes', summary: 'b', score: 40, createdAt: new Date('2026-06-24T11:00:00Z') },
        { id: 'r3', runId: 'run3', verdict: 'comment', summary: 'c', score: 70, createdAt: new Date('2026-06-24T11:30:00Z') },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.verdict).toBe('request_changes');
    expect(out.data.summary).toBe('b'); // summary comes from the worst-verdict review
  });

  it('tie-breaks summary by recency when two reviews share the worst verdict', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'request_changes', summary: 'older', score: 30, createdAt: new Date('2026-06-24T08:00:00Z') },
        { id: 'r2', runId: 'run2', verdict: 'request_changes', summary: 'newer', score: 50, createdAt: new Date('2026-06-24T09:00:00Z') },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.summary).toBe('newer');
  });

  it('computes score as round(mean(scores)) ignoring nulls', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'approve', summary: 's', score: 80, createdAt: now },
        { id: 'r2', runId: 'run2', verdict: 'approve', summary: 's', score: 91, createdAt: now },
        { id: 'r3', runId: 'run3', verdict: 'approve', summary: 's', score: null, createdAt: now },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.score).toBe(86); // round((80+91)/2) = 86
  });

  it('returns null score when every review.score is null', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'comment', summary: 's', score: null, createdAt: now },
      ],
      findings: [],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.score).toBeNull();
  });

  it('counts findings; blockers = severity blocker|critical (case-insensitive)', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'request_changes', summary: 's', score: 50, createdAt: now },
      ],
      findings: [
        { reviewId: 'r1', severity: 'blocker' },
        { reviewId: 'r1', severity: 'CRITICAL' },
        { reviewId: 'r1', severity: 'warning' },
        { reviewId: 'r1', severity: 'suggestion' },
      ],
      runCosts: [],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.findingsCount).toBe(4);
    expect(out.data.blockersCount).toBe(2);
  });

  it('sums totalCost across all runs that produced a review and lists basedOnRunIds', () => {
    const out = aggregatePrBrief({
      reviews: [
        { id: 'r1', runId: 'run1', verdict: 'approve', summary: 's', score: 80, createdAt: now },
        { id: 'r2', runId: 'run2', verdict: 'approve', summary: 's', score: 90, createdAt: now },
        { id: 'r3', runId: 'run3',   verdict: 'comment', summary: 's', score: 70, createdAt: now }, // no cost entry for run3
      ],
      findings: [],
      runCosts: [
        { runId: 'run1', tokensIn: 1000, tokensOut: 200, usd: 0.012 },
        { runId: 'run2', tokensIn: 500,  tokensOut: 100, usd: 0.006 },
      ],
      now,
    });
    if (out.status !== 'ready') throw new Error('unreachable');
    expect(out.data.totalCost).toEqual({ tokensIn: 1500, tokensOut: 300, usd: 0.018 });
    expect(out.data.basedOnRunIds.sort()).toEqual(['run1', 'run2', 'run3'].sort());
  });
});
