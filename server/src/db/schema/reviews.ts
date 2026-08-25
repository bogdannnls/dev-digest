import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, jsonb, timestamp, doublePrecision, numeric } from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';
import { pullRequests } from './pulls';

/**
 * Row shape persisted in `pr_intent.references` (JSONB). Defined locally here
 * rather than in a separate `intent/types.ts` module — this file is the only
 * place that needs the shape until the intent module's repository (P1-T7)
 * imports it. Mirrors spec §6.3.
 */
export type IntentReferenceRow = {
  kind: 'github_issue' | 'jira' | 'linear' | 'url';
  id: string;
  status:
    | 'ok'
    | 'not_allowlisted'
    | 'no_auth'
    | 'unreachable'
    | 'timeout'
    | 'too_large'
    | 'not_found'
    | 'parse_error';
  bodyHash: string | null;
  bodyChars: number;
  fetchedAt: string;
  error: string | null;
};

/** Icon values for `pr_intent.risk_areas[].icon`. Mirrors the shared `RiskAreaIcon` contract enum. */
export type RiskAreaIcon = 'shield' | 'package' | 'zap' | 'database' | 'globe';

// ============================================================ Review & findings

export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id'),
  /** The agent_run that produced this review (links the timeline run ↔ review). */
  runId: uuid('run_id'),
  kind: text('kind', { enum: ['summary', 'review'] }).notNull(),
  verdict: text('verdict'),
  summary: text('summary'),
  score: integer('score'),
  model: text('model'),
  createdAt: now(),
});

export const findings = pgTable('findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  file: text('file').notNull(),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  severity: text('severity').notNull(),
  category: text('category').notNull(),
  title: text('title').notNull(),
  rationale: text('rationale').notNull(),
  suggestion: text('suggestion'),
  confidence: doublePrecision('confidence').notNull(),
  kind: text('kind').notNull().default('finding'),
  trifectaComponents: jsonb('trifecta_components').$type<string[]>(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
});

export const prIntent = pgTable('pr_intent', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  intent: text('intent').notNull(),
  inScope: jsonb('in_scope').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  outOfScope: jsonb('out_of_scope').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  headSha: text('head_sha').notNull(),
  bodyHash: text('body_hash').notNull(),
  references: jsonb('references').$type<IntentReferenceRow[]>().notNull().default(sql`'[]'::jsonb`),
  riskAreas: jsonb('risk_areas')
    .$type<{ icon: RiskAreaIcon; label: string }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  model: text('model'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const prBrief = pgTable('pr_brief', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  json: jsonb('json').notNull(),
  headSha: text('head_sha').notNull(),
  reviewId: uuid('review_id').references(() => reviews.id, { onDelete: 'set null' }),
  intentComputedAt: timestamp('intent_computed_at', { withTimezone: true }).notNull(),
  riskLevel: text('risk_level').notNull(),
  model: text('model'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});
