import { z } from 'zod';

/**
 * PR Brief building blocks: Intent, Blast radius, Risks, PR History,
 * Smart Diff. Each is a standalone contract consumed independently by its
 * own feature — no single composed type unifies them.
 */

// ---- Intent ----
export const Intent = z.object({
  intent: z.string(),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});
export type Intent = z.infer<typeof Intent>;

// ---- Blast radius ----
export const ChangedSymbol = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.string(),
});
export type ChangedSymbol = z.infer<typeof ChangedSymbol>;

export const BlastCaller = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
});
export type BlastCaller = z.infer<typeof BlastCaller>;

export const DownstreamImpact = z.object({
  symbol: z.string(),
  callers: z.array(BlastCaller),
  endpoints_affected: z.array(z.string()),
  crons_affected: z.array(z.string()),
});
export type DownstreamImpact = z.infer<typeof DownstreamImpact>;

export const BlastRadius = z.object({
  changed_symbols: z.array(ChangedSymbol),
  downstream: z.array(DownstreamImpact),
  summary: z.string(),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

// ---- Risks ----
export const RiskSeverity = z.enum(['high', 'medium', 'low']);
export type RiskSeverity = z.infer<typeof RiskSeverity>;

export const Risk = z.object({
  kind: z.string(),
  title: z.string(),
  explanation: z.string(),
  severity: RiskSeverity,
  file_refs: z.array(z.string()),
});
export type Risk = z.infer<typeof Risk>;

export const Risks = z.object({
  risks: z.array(Risk),
});
export type Risks = z.infer<typeof Risks>;

// ---- PR History ----
export const PrHistoryItem = z.object({
  pr_number: z.number().int(),
  title: z.string(),
  merged_at: z.string(),
  author: z.string(),
  files_overlap: z.array(z.string()),
  notes: z.string(),
});
export type PrHistoryItem = z.infer<typeof PrHistoryItem>;

export const PrHistory = z.object({
  history: z.array(PrHistoryItem),
});
export type PrHistory = z.infer<typeof PrHistory>;

// ---- Smart Diff ----
export const SmartDiffRole = z.enum(['core', 'wiring', 'boilerplate']);
export type SmartDiffRole = z.infer<typeof SmartDiffRole>;

export const SmartDiffFile = z.object({
  path: z.string(),
  pseudocode_summary: z.string().nullish(),
  additions: z.number().int(),
  deletions: z.number().int(),
  finding_lines: z.array(z.number().int()),
});
export type SmartDiffFile = z.infer<typeof SmartDiffFile>;

export const SmartDiffGroup = z.object({
  role: SmartDiffRole,
  files: z.array(SmartDiffFile),
});
export type SmartDiffGroup = z.infer<typeof SmartDiffGroup>;

export const ProposedSplit = z.object({
  name: z.string(),
  files: z.array(z.string()),
});
export type ProposedSplit = z.infer<typeof ProposedSplit>;

export const SmartDiff = z.object({
  groups: z.array(SmartDiffGroup),
  split_suggestion: z.object({
    too_big: z.boolean(),
    total_lines: z.number().int(),
    proposed_splits: z.array(ProposedSplit),
  }),
});
export type SmartDiff = z.infer<typeof SmartDiff>;

// ---- Intent Layer (pr_intent overview card, see docs/superpowers/specs/2026-07-04-intent-layer-design.md §7) ----
// NOTE: do NOT mutate the `Intent` schema above — it is already shipped to the reviewer pipeline.
export const RiskAreaIcon = z.enum(['shield', 'package', 'zap', 'database', 'globe']);
export type RiskAreaIcon = z.infer<typeof RiskAreaIcon>;

// All 4 kinds are declared now even though P1 only populates `github_issue`,
// so P2 (jira/linear) and P3 (url) need no contract migration.
export const IntentReferenceKind = z.enum(['github_issue', 'jira', 'linear', 'url']);
export type IntentReferenceKind = z.infer<typeof IntentReferenceKind>;

// All 8 statuses are declared now for the same reason; P1 only ever emits
// 'ok' | 'not_found' | 'unreachable' | 'timeout' from the GitHub collector.
export const IntentReferenceStatus = z.enum([
  'ok',
  'not_allowlisted',
  'no_auth',
  'unreachable',
  'timeout',
  'too_large',
  'not_found',
  'parse_error',
]);
export type IntentReferenceStatus = z.infer<typeof IntentReferenceStatus>;

export const IntentReferenceDto = z.object({
  kind: IntentReferenceKind,
  id: z.string(),
  status: IntentReferenceStatus,
  bodyChars: z.number().int().nonnegative(),
});
export type IntentReferenceDto = z.infer<typeof IntentReferenceDto>;

export const PrIntentDto = z.object({
  goal: z.string().min(1),
  inScope: z.array(z.string()).max(20),
  outOfScope: z.array(z.string()).max(20),
  riskAreas: z
    .array(
      z.object({
        icon: RiskAreaIcon,
        label: z.string().min(1).max(40),
      }),
    )
    .max(3),
  references: z.array(IntentReferenceDto).max(20),
  model: z.string(),
  cost: z.object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  computedAt: z.string(),
});
export type PrIntentDto = z.infer<typeof PrIntentDto>;

export const PrIntentStaleReason = z.enum(['head_sha', 'body']);
export type PrIntentStaleReason = z.infer<typeof PrIntentStaleReason>;

export const PrIntentResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), data: PrIntentDto }),
  z.object({
    status: z.literal('ready-stale'),
    data: PrIntentDto,
    staleReasons: z.array(PrIntentStaleReason).min(1),
  }),
  z.object({ status: z.literal('computing'), runId: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
export type PrIntentResponse = z.infer<typeof PrIntentResponse>;
