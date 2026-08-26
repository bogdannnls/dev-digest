import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { AgentRow, FindingRow, PullRow } from '../../db/rows.js';

/**
 * L06 — eval data-access. Owns `eval_cases`, `eval_run_batches` and `eval_runs`.
 * Workspace-scoped throughout.
 *
 * Onion MUST.4 forbids this module importing the agents or reviews domain
 * modules — so this repository issues its OWN Drizzle queries against
 * `agents`, `agent_skills`, `skills`, `findings`, `reviews` and `pr_files`
 * rather than reusing those modules' repositories. This mirrors the
 * established precedent of the reviews domain's run-repository joining
 * `t.agents` directly (contract §0).
 */

export type EvalCaseRow = typeof t.evalCases.$inferSelect;
export type EvalRunBatchRow = typeof t.evalRunBatches.$inferSelect;
export type EvalRunRow = typeof t.evalRuns.$inferSelect;
export type ReviewRow = typeof t.reviews.$inferSelect;

export interface InsertEvalCase {
  workspaceId: string;
  ownerId: string;
  name: string;
  inputDiff: string;
  inputFiles: null;
  inputMeta: unknown;
  expectedOutput: unknown;
  notes: string | null;
}

export interface UpdateEvalCase {
  name: string;
  inputDiff: string;
  expectedOutput: unknown;
  notes: string | null;
}

export interface InsertEvalRunBatch {
  workspaceId: string;
  ownerId: string;
  agentVersion: number | null;
  systemPrompt: string;
  model: string;
  provider: string;
  casesTotal: number;
}

export interface FinishEvalRunBatch {
  status: 'succeeded' | 'failed';
  finishedAt: Date;
  tracesPassed: number;
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  durationMs: number;
  costUsd: number | null;
  tokensIn: number;
  tokensOut: number;
  error: string | null;
}

export interface InsertEvalRun {
  caseId: string;
  batchId: string;
  actualOutput: unknown;
  pass: boolean;
  /** Null only when the case produced no findings at all — a vacuous
   *  denominator, not a score of zero. `recall` has no per-case column value
   *  by design; see the comment in `service.runBatch`. */
  precision: number | null;
  citationAccuracy: number | null;
  durationMs: number;
  costUsd: number | null;
}

export class EvalRepository {
  constructor(private db: Db) {}

  // ---- agents (own query — onion MUST.4 forbids importing the agents module) --

  async getAgent(workspaceId: string, agentId: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, agentId)));
    return row;
  }

  /** Unscoped lookup — used only to resolve the owner of a finding-derived
   *  case (contract §4.4 step 1), which is not yet known to belong to the
   *  caller's workspace until the review is checked. */
  async getAgentById(agentId: string): Promise<AgentRow | undefined> {
    const [row] = await this.db.select().from(t.agents).where(eq(t.agents.id, agentId));
    return row;
  }

  async listAgentsForWorkspace(workspaceId: string): Promise<AgentRow[]> {
    return this.db.select().from(t.agents).where(eq(t.agents.workspaceId, workspaceId));
  }

  /** Mirrors the agents domain's `enabledSkillBodiesForAgent` (repository.ts:282-290) —
   *  duplicated rather than imported per onion MUST.4. Empty bodies excluded. */
  async enabledSkillBodiesForAgent(agentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ body: t.skills.body, order: t.agentSkills.order })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.enabled, true)))
      .orderBy(asc(t.agentSkills.order));
    return rows.map((r) => r.body).filter((b) => b.length > 0);
  }

  // ---- eval_cases -----------------------------------------------------------

  /** All of an agent's cases, name-ascending (§1.1 — no `created_at` column exists). */
  async listCasesForOwner(workspaceId: string, ownerId: string): Promise<EvalCaseRow[]> {
    return this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, ownerId),
        ),
      )
      .orderBy(asc(t.evalCases.name));
  }

  async countCasesForOwner(workspaceId: string, ownerId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, ownerId),
        ),
      );
    return row?.count ?? 0;
  }

  async getCase(workspaceId: string, caseId: string): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)));
    return row;
  }

  async getCasesByIds(
    workspaceId: string,
    ownerId: string,
    ids: string[],
  ): Promise<EvalCaseRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, ownerId),
          inArray(t.evalCases.id, ids),
        ),
      );
  }

  /** Idempotency lookup for contract §4.4 step 7 — a case already derived
   *  from this finding for this owner, if any. */
  async getCaseBySourceFinding(
    workspaceId: string,
    ownerId: string,
    findingId: string,
  ): Promise<EvalCaseRow | undefined> {
    const rows = await this.listCasesForOwner(workspaceId, ownerId);
    return rows.find((r) => {
      const meta = r.inputMeta as { source_finding_id?: string | null } | null;
      return meta?.source_finding_id === findingId;
    });
  }

  async insertCase(values: InsertEvalCase): Promise<EvalCaseRow> {
    const [row] = await this.db
      .insert(t.evalCases)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: 'agent',
        ownerId: values.ownerId,
        name: values.name,
        inputDiff: values.inputDiff,
        inputFiles: values.inputFiles,
        inputMeta: values.inputMeta,
        expectedOutput: values.expectedOutput,
        notes: values.notes,
      })
      .returning();
    return row!;
  }

  async updateCase(
    workspaceId: string,
    caseId: string,
    patch: UpdateEvalCase,
  ): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .update(t.evalCases)
      .set({
        name: patch.name,
        inputDiff: patch.inputDiff,
        expectedOutput: patch.expectedOutput,
        notes: patch.notes,
      })
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)))
      .returning();
    return row;
  }

  async deleteCase(workspaceId: string, caseId: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)))
      .returning({ id: t.evalCases.id });
    return rows.length > 0;
  }

  // ---- finding lookup (own query — onion MUST.4 forbids importing the reviews module) --

  /** Resolve a finding + its review + the review's pull, fully offline
   *  (contract §4.4 step 1). Mirrors the reviews domain's `findingContext`
   *  helper, duplicated here rather than imported. */
  async findingContext(
    findingId: string,
  ): Promise<{ finding: FindingRow; review: ReviewRow; pull: PullRow } | undefined> {
    const [finding] = await this.db.select().from(t.findings).where(eq(t.findings.id, findingId));
    if (!finding) return undefined;
    const [review] = await this.db.select().from(t.reviews).where(eq(t.reviews.id, finding.reviewId));
    if (!review) return undefined;
    const [pull] = await this.db
      .select()
      .from(t.pullRequests)
      .where(eq(t.pullRequests.id, review.prId));
    if (!pull) return undefined;
    return { finding, review, pull };
  }

  /** `pr_files` rows for one PR path (contract §4.4 step 4 — the diff-fragment source). */
  async getPrFilesForPath(
    prId: string,
    path: string,
  ): Promise<(typeof t.prFiles.$inferSelect)[]> {
    return this.db
      .select()
      .from(t.prFiles)
      .where(and(eq(t.prFiles.prId, prId), eq(t.prFiles.path, path)));
  }

  // ---- eval_run_batches -------------------------------------------------------

  async insertBatch(values: InsertEvalRunBatch): Promise<EvalRunBatchRow> {
    const [row] = await this.db
      .insert(t.evalRunBatches)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: 'agent',
        ownerId: values.ownerId,
        agentVersion: values.agentVersion,
        systemPrompt: values.systemPrompt,
        model: values.model,
        provider: values.provider,
        casesTotal: values.casesTotal,
      })
      .returning();
    return row!;
  }

  async finishBatch(
    batchId: string,
    patch: FinishEvalRunBatch,
  ): Promise<EvalRunBatchRow | undefined> {
    const [row] = await this.db
      .update(t.evalRunBatches)
      .set({
        status: patch.status,
        finishedAt: patch.finishedAt,
        tracesPassed: patch.tracesPassed,
        recall: patch.recall,
        precision: patch.precision,
        citationAccuracy: patch.citationAccuracy,
        durationMs: patch.durationMs,
        costUsd: patch.costUsd,
        tokensIn: patch.tokensIn,
        tokensOut: patch.tokensOut,
        error: patch.error,
      })
      .where(eq(t.evalRunBatches.id, batchId))
      .returning();
    return row;
  }

  async getBatch(
    workspaceId: string,
    ownerId: string,
    batchId: string,
  ): Promise<EvalRunBatchRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalRunBatches)
      .where(
        and(
          eq(t.evalRunBatches.workspaceId, workspaceId),
          eq(t.evalRunBatches.ownerId, ownerId),
          eq(t.evalRunBatches.id, batchId),
        ),
      );
    return row;
  }

  /** Newest-first, capped by `limit` (contract §4.1 — default 20, `?limit=` capped at 100). */
  async listBatches(
    workspaceId: string,
    ownerId: string,
    limit: number,
  ): Promise<EvalRunBatchRow[]> {
    return this.db
      .select()
      .from(t.evalRunBatches)
      .where(
        and(
          eq(t.evalRunBatches.workspaceId, workspaceId),
          eq(t.evalRunBatches.ownerKind, 'agent'),
          eq(t.evalRunBatches.ownerId, ownerId),
        ),
      )
      .orderBy(desc(t.evalRunBatches.ranAt))
      .limit(limit);
  }

  /** Every batch for one agent, newest-first — used by the dashboard for
   *  current/previous/trend derivation. */
  async listAllBatchesForOwner(workspaceId: string, ownerId: string): Promise<EvalRunBatchRow[]> {
    return this.db
      .select()
      .from(t.evalRunBatches)
      .where(
        and(
          eq(t.evalRunBatches.workspaceId, workspaceId),
          eq(t.evalRunBatches.ownerKind, 'agent'),
          eq(t.evalRunBatches.ownerId, ownerId),
        ),
      )
      .orderBy(desc(t.evalRunBatches.ranAt));
  }

  /** Cross-agent recent batches for the dashboard landing view, joined with
   *  the owning agent's name. */
  async listRecentBatchesAcrossOwners(
    workspaceId: string,
    limit: number,
  ): Promise<(EvalRunBatchRow & { agentName: string })[]> {
    const rows = await this.db
      .select({ batch: t.evalRunBatches, agentName: t.agents.name })
      .from(t.evalRunBatches)
      .innerJoin(t.agents, eq(t.agents.id, t.evalRunBatches.ownerId))
      .where(
        and(
          eq(t.evalRunBatches.workspaceId, workspaceId),
          eq(t.evalRunBatches.ownerKind, 'agent'),
        ),
      )
      .orderBy(desc(t.evalRunBatches.ranAt))
      .limit(limit);
    return rows.map((r) => ({ ...r.batch, agentName: r.agentName }));
  }

  // ---- eval_runs (per-case) ---------------------------------------------------

  async insertRun(values: InsertEvalRun): Promise<EvalRunRow> {
    const [row] = await this.db
      .insert(t.evalRuns)
      .values({
        caseId: values.caseId,
        batchId: values.batchId,
        actualOutput: values.actualOutput,
        pass: values.pass,
        precision: values.precision,
        citationAccuracy: values.citationAccuracy,
        durationMs: values.durationMs,
        costUsd: values.costUsd,
      })
      .returning();
    return row!;
  }

  /** All per-case rows for a batch, in run order, joined with the case's name
   *  (`EvalRunRecord.case_name`, §2.5/§4.7). */
  async listRunsForBatch(batchId: string): Promise<(EvalRunRow & { caseName: string | null })[]> {
    const rows = await this.db
      .select({ run: t.evalRuns, caseName: t.evalCases.name })
      .from(t.evalRuns)
      .leftJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
      .where(eq(t.evalRuns.batchId, batchId))
      .orderBy(asc(t.evalRuns.ranAt));
    return rows.map((r) => ({ ...r.run, caseName: r.caseName ?? null }));
  }
}
