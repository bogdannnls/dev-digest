import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { PullRow } from '../../db/rows.js';
import type {
  ReviewRowSlim,
  FindingRowSlim,
  RunCostRowSlim,
} from './brief/aggregate.js';

export type OverviewBriefInputs = {
  reviews: ReviewRowSlim[];
  findings: FindingRowSlim[];
  runCosts: RunCostRowSlim[];
};

/**
 * Read-only access for the Overview tab. Slice A only needs the per-PR
 * review/finding/run-cost rows; no writes, no cache table.
 */
export class OverviewRepository {
  constructor(private db: Db) {}

  async getPull(workspaceId: string, prId: string): Promise<PullRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  /**
   * Load every review for the PR (kind='review'), its findings, and the
   * cost of the agent_runs that produced them. USD is computed here via
   * the injected price-book estimator so the aggregator stays pure.
   */
  async getBriefInputs(
    prId: string,
    estimateCost: (model: string | null, tokensIn: number, tokensOut: number) => number | null,
  ): Promise<OverviewBriefInputs> {
    const reviewRows = await this.db
      .select({
        id: t.reviews.id,
        runId: t.reviews.runId,
        verdict: t.reviews.verdict,
        summary: t.reviews.summary,
        score: t.reviews.score,
        createdAt: t.reviews.createdAt,
      })
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.kind, 'review')));

    const reviews: ReviewRowSlim[] = reviewRows.map((r) => ({
      id: r.id,
      runId: r.runId,
      verdict:
        r.verdict === 'approve' || r.verdict === 'request_changes' || r.verdict === 'comment'
          ? r.verdict
          : null,
      summary: r.summary,
      score: r.score,
      createdAt: r.createdAt as Date,
    }));

    if (reviews.length === 0) {
      return { reviews: [], findings: [], runCosts: [] };
    }

    const reviewIds = reviews.map((r) => r.id);
    const runIds = Array.from(
      new Set(reviews.map((r) => r.runId).filter((id): id is string => !!id)),
    );

    const findingRows = await this.db
      .select({ reviewId: t.findings.reviewId, severity: t.findings.severity })
      .from(t.findings)
      .where(inArray(t.findings.reviewId, reviewIds));
    const findings: FindingRowSlim[] = findingRows.map((f) => ({
      reviewId: f.reviewId,
      severity: f.severity,
    }));

    let runCosts: RunCostRowSlim[] = [];
    if (runIds.length > 0) {
      const runRows = await this.db
        .select({
          id: t.agentRuns.id,
          model: t.agentRuns.model,
          tokensIn: t.agentRuns.tokensIn,
          tokensOut: t.agentRuns.tokensOut,
        })
        .from(t.agentRuns)
        .where(inArray(t.agentRuns.id, runIds));
      runCosts = runRows.map((r) => ({
        runId: r.id,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        usd: estimateCost(r.model ?? null, r.tokensIn ?? 0, r.tokensOut ?? 0) ?? 0,
      }));
    }

    return { reviews, findings, runCosts };
  }
}
