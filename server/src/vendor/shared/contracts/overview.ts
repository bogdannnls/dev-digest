import { z } from 'zod';

/**
 * PR Overview tab — Slice A: Brief.
 *
 * Named `PrOverviewBrief` (not `PrBrief`) to stay distinct from the
 * building-block contracts in `./brief.ts` (Intent, BlastRadius, Risks,
 * PrHistory, SmartDiff) — this is a small aggregation card driven by
 * existing reviews/findings/agent_runs, not a composite of those blocks.
 */
export const PrOverviewBriefVerdict = z.enum([
  'approve',
  'request_changes',
  'comment',
]);
export type PrOverviewBriefVerdict = z.infer<typeof PrOverviewBriefVerdict>;

export const PrOverviewBriefCost = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type PrOverviewBriefCost = z.infer<typeof PrOverviewBriefCost>;

export const PrOverviewBrief = z.object({
  verdict: PrOverviewBriefVerdict,
  summary: z.string(),
  findingsCount: z.number().int().nonnegative(),
  blockersCount: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100).nullable(),
  totalCost: PrOverviewBriefCost,
  computedAt: z.string(),
  basedOnRunIds: z.array(z.string()),
});
export type PrOverviewBrief = z.infer<typeof PrOverviewBrief>;

export const PrOverviewBriefResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), data: PrOverviewBrief }),
  z.object({ status: z.literal('no_runs') }),
]);
export type PrOverviewBriefResponse = z.infer<typeof PrOverviewBriefResponse>;
