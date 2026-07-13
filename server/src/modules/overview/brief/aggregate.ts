import type {
  PrOverviewBriefResponse,
  PrOverviewBriefVerdict,
} from '@devdigest/shared';

export type ReviewRowSlim = {
  id: string;
  runId: string | null;
  verdict: 'approve' | 'request_changes' | 'comment' | null;
  summary: string | null;
  score: number | null;
  createdAt: Date;
};

export type FindingRowSlim = {
  reviewId: string;
  severity: string;
};

export type RunCostRowSlim = {
  runId: string;
  tokensIn: number | null;
  tokensOut: number | null;
  usd: number;
};

export type AggregateInput = {
  reviews: ReviewRowSlim[];
  findings: FindingRowSlim[];
  runCosts: RunCostRowSlim[];
  now: Date;
};

// Worst-verdict precedence per spec §5.1.
const VERDICT_RANK: Record<'approve' | 'comment' | 'request_changes', number> = {
  approve: 0,
  comment: 1,
  request_changes: 2,
};

export const BLOCKER_SEVERITIES = new Set(['blocker', 'critical']);

/**
 * Pure aggregator for the Overview tab's PR Brief card.
 * No DB, no IO — fed by the repository layer.
 */
export function aggregatePrBrief(input: AggregateInput): PrOverviewBriefResponse {
  const { reviews, findings, runCosts, now } = input;

  if (reviews.length === 0) {
    return { status: 'no_runs' };
  }

  // Pick the worst verdict; tie-break by recency (most recent wins).
  let worst: ReviewRowSlim | null = null;
  for (const r of reviews) {
    if (!r.verdict) continue;
    if (!worst) {
      worst = r;
      continue;
    }
    const cmp = VERDICT_RANK[r.verdict] - VERDICT_RANK[worst.verdict!];
    if (cmp > 0 || (cmp === 0 && r.createdAt > worst.createdAt)) {
      worst = r;
    }
  }

  // If somehow no review carried a verdict, treat as no_runs.
  if (!worst || !worst.verdict) {
    return { status: 'no_runs' };
  }

  const verdict: PrOverviewBriefVerdict = worst.verdict;
  const summary = worst.summary ?? '';

  const scoreValues = reviews.map((r) => r.score).filter((s): s is number => s != null);
  const score = scoreValues.length
    ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length)
    : null;

  const findingsCount = findings.length;
  const blockersCount = findings.filter((f) =>
    BLOCKER_SEVERITIES.has(f.severity.toLowerCase()),
  ).length;

  const totalCost = runCosts.reduce(
    (acc, c) => ({
      tokensIn: acc.tokensIn + (c.tokensIn ?? 0),
      tokensOut: acc.tokensOut + (c.tokensOut ?? 0),
      usd: acc.usd + c.usd,
    }),
    { tokensIn: 0, tokensOut: 0, usd: 0 },
  );
  // Sanitize USD to remove floating-point accumulation errors (round to 3 decimal places).
  totalCost.usd = Math.round(totalCost.usd * 1000) / 1000;

  const basedOnRunIds = Array.from(
    new Set(reviews.map((r) => r.runId).filter((id): id is string => !!id)),
  );

  return {
    status: 'ready',
    data: {
      verdict,
      summary,
      findingsCount,
      blockersCount,
      score,
      totalCost,
      computedAt: now.toISOString(),
      basedOnRunIds,
    },
  };
}
