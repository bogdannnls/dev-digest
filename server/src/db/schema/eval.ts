import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, doublePrecision } from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { pullRequests } from './pulls';

// ============================================================ Eval / Conformance / Compose

export const evalCases = pgTable('eval_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerKind: text('owner_kind', { enum: ['skill', 'agent'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull(),
  inputDiff: text('input_diff'),
  inputFiles: jsonb('input_files'),
  inputMeta: jsonb('input_meta'),
  expectedOutput: jsonb('expected_output'),
  notes: text('notes'),
});

/**
 * One row per set-run (the thing a user calls a "run" and compares two of).
 * `eval_runs.case_id` is `NOT NULL`, so an `eval_runs` row is definitionally
 * one case executed once and cannot represent a run over a whole set — this
 * table carries the set-level identity and aggregate metrics instead. See
 * INSIGHTS.md 2026-08-25 for why the alternative (nullable-ing `case_id`) was
 * rejected.
 */
export const evalRunBatches = pgTable('eval_run_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerKind: text('owner_kind', { enum: ['skill', 'agent'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  /** Snapshot of `agents.version` at run time; nullable. */
  agentVersion: integer('agent_version'),
  /** Verbatim snapshot, powers the prompt-diff view. */
  systemPrompt: text('system_prompt').notNull(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] })
    .notNull()
    .default('running'),
  casesTotal: integer('cases_total').notNull(),
  tracesPassed: integer('traces_passed').notNull().default(0),
  // Nullable — every metric is null when its denominator is zero (section 3.4
  // of the eval-pipeline contract), never coerced to 0.
  recall: doublePrecision('recall'),
  precision: doublePrecision('precision'),
  citationAccuracy: doublePrecision('citation_accuracy'),
  durationMs: integer('duration_ms'),
  costUsd: doublePrecision('cost_usd'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  error: text('error'),
});

export const evalRuns = pgTable('eval_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id')
    .notNull()
    .references(() => evalCases.id, { onDelete: 'cascade' }),
  /** Nullable only so the ALTER is safe on existing rows; every row this feature writes sets it. */
  batchId: uuid('batch_id').references(() => evalRunBatches.id, { onDelete: 'cascade' }),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
  actualOutput: jsonb('actual_output'),
  pass: boolean('pass'),
  recall: doublePrecision('recall'),
  precision: doublePrecision('precision'),
  citationAccuracy: doublePrecision('citation_accuracy'),
  durationMs: integer('duration_ms'),
  costUsd: doublePrecision('cost_usd'),
});

export const conformanceChecks = pgTable('conformance_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  specId: text('spec_id').notNull(),
  completenessPct: doublePrecision('completeness_pct'),
  items: jsonb('items'),
});

export const composedReviews = pgTable('composed_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  verdict: text('verdict'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  githubReviewId: text('github_review_id'),
});
