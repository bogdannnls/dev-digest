import { z } from 'zod';
import { RiskAreaIcon, RiskSeverity } from './brief.js';

/**
 * Why + Risk Brief (SPEC-02): a second, thin LLM pass that composes
 * already-computed PR artifacts (Intent, RepoIntel.getBlastRadius,
 * latest-review findings, SmartDiff, attached-spec paths) into one
 * synthesized brief. Read-through cached in the `pr_brief` table.
 *
 * See docs/superpowers/specs/2026-07-13-why-risk-brief-design.md and
 * specs/2026-07-13-why-risk-brief-spec.md (SPEC-02).
 */

// ---- Risk area (server-attached fileRef; icon/label reused verbatim from intent.riskAreas) ----
export const RiskArea = z.object({
  icon: RiskAreaIcon,
  label: z.string(),
  fileRef: z
    .object({
      file: z.string(),
      line: z.number().int(),
    })
    .optional(),
});
export type RiskArea = z.infer<typeof RiskArea>;

// ---- Review focus item: findingId + note only — never a model-emitted file/line (AC-2) ----
export const ReviewFocusItem = z
  .object({
    findingId: z.string(),
    note: z.string(),
  })
  .strict();
export type ReviewFocusItem = z.infer<typeof ReviewFocusItem>;

// ---- The synthesized brief itself ----
export const PrWhyRiskBrief = z.object({
  what: z.string(),
  why: z.string(),
  riskLevel: RiskSeverity,
  risks: z.array(RiskArea),
  reviewFocus: z.array(ReviewFocusItem),
  model: z.string(),
  cost: z.object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  computedAt: z.string(),
  basedOn: z.object({
    headSha: z.string(),
    // Nullable: the anchor review can be deleted after the brief is computed
    // (pr_brief.review_id FK is ON DELETE SET NULL). A served brief may outlive it.
    reviewId: z.string().nullable(),
    intentComputedAt: z.string(),
  }),
});
export type PrWhyRiskBrief = z.infer<typeof PrWhyRiskBrief>;

// ---- Staleness / missing-input reasons ----
export const PrWhyRiskBriefStaleReason = z.enum(['head_sha', 'new_review', 'intent']);
export type PrWhyRiskBriefStaleReason = z.infer<typeof PrWhyRiskBriefStaleReason>;

export const PrWhyRiskBriefMissingInput = z.enum(['intent', 'review']);
export type PrWhyRiskBriefMissingInput = z.infer<typeof PrWhyRiskBriefMissingInput>;

// ---- Response envelope (discriminated by status) ----
export const PrWhyRiskBriefResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), data: PrWhyRiskBrief }),
  z.object({
    status: z.literal('ready-stale'),
    data: PrWhyRiskBrief,
    staleReasons: z.array(PrWhyRiskBriefStaleReason).min(1),
  }),
  z.object({
    status: z.literal('not_ready'),
    missing: z.array(PrWhyRiskBriefMissingInput).min(1),
  }),
  z.object({ status: z.literal('computing'), runId: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
export type PrWhyRiskBriefResponse = z.infer<typeof PrWhyRiskBriefResponse>;
