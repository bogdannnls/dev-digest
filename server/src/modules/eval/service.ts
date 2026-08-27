import type { Container } from '../../platform/container.js';
import type {
  EvalBatchDetail,
  EvalCase,
  EvalCaseManualInput,
  EvalCaseMeta,
  EvalDashboard,
  EvalDashboardAgentSummary,
  EvalDashboardIndex,
  EvalExpectation,
  EvalRunComparison,
  EvalTrendPoint,
  FindingCategory,
  Finding,
  Provider,
  Severity,
} from '@devdigest/shared';
import { EvalExpectation as EvalExpectationSchema } from '@devdigest/shared';
import {
  reviewPullRequest,
  scoreBatch,
  scoreCase,
  type EvalCaseScoreInput,
  type EvalExpectationLike,
  type ReviewOutcome,
} from '@devdigest/reviewer-core';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import { assembleDiffFragment } from '../_shared/diff-fragment.js';
import { ValidationError } from '../../platform/errors.js';
import {
  EvalRepository,
  type EvalRunBatchRow,
} from './repository.js';
import {
  computeAlert,
  dedupeCaseName,
  metricDelta,
  slugify,
  toEvalBatchRecordDto,
  toEvalCaseDto,
  toEvalRunRecordDto,
} from './helpers.js';

/**
 * L06 — eval service. Replays an agent's eval set through the real review
 * path (`reviewPullRequest`) as a persisted batch, then hands the results to
 * `reviewer-core`'s pure scorer. The LLM call and the scoring step stay in
 * two clearly separate phases in `runBatch` below — that split is itself a
 * graded acceptance criterion (contract §3 / CONTEXT).
 */

const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 100;
const DASHBOARD_RECENT_RUNS_LIMIT = 20;

/** The shape persisted into `eval_runs.actual_output` for a failed case
 *  (contract §4.6) — deliberately just `{ error }`, not the full §4.7 shape. */
interface FailedActualOutput {
  error: string;
}

/** The shape persisted into `eval_runs.actual_output` for a completed case
 *  (contract §4.7). */
interface CompletedActualOutput {
  findings: Finding[];
  dropped: number;
  grounding: string;
  matched_finding_id: string | null;
}

/**
 * One case's outcome from the replay phase — either a successful
 * `ReviewOutcome` or an error message. Carries zero scoring information;
 * `runBatch`'s second phase is the only place that calls into the pure
 * scorer, keeping the LLM-calling and scoring phases structurally separate.
 */
interface CaseReplay {
  caseId: string;
  expectation: EvalExpectationLike;
  outcome?: ReviewOutcome;
  errorMessage?: string;
  durationMs: number;
}

export class EvalService {
  private repo: EvalRepository;

  constructor(private container: Container) {
    this.repo = new EvalRepository(container.db);
  }

  // ---- cases (§4.2) ----------------------------------------------------------

  async listCases(workspaceId: string, agentId: string): Promise<EvalCase[] | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;
    const rows = await this.repo.listCasesForOwner(workspaceId, agentId);
    return rows.map(toEvalCaseDto);
  }

  async createManualCase(
    workspaceId: string,
    agentId: string,
    input: EvalCaseManualInput,
  ): Promise<EvalCase | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;
    const meta: EvalCaseMeta = {
      origin: 'manual',
      source_finding_id: null,
      source_pr_id: null,
      source_review_id: null,
    };
    const row = await this.repo.insertCase({
      workspaceId,
      ownerId: agentId,
      name: input.name,
      inputDiff: input.input_diff,
      inputFiles: null,
      inputMeta: meta,
      expectedOutput: input.expected_output,
      notes: input.notes ?? null,
    });
    return toEvalCaseDto(row);
  }

  async updateCase(
    workspaceId: string,
    agentId: string,
    caseId: string,
    input: EvalCaseManualInput,
  ): Promise<EvalCase | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;
    const existing = await this.repo.getCase(workspaceId, caseId);
    if (!existing || existing.ownerId !== agentId) return undefined;
    const row = await this.repo.updateCase(workspaceId, caseId, {
      name: input.name,
      inputDiff: input.input_diff,
      expectedOutput: input.expected_output,
      notes: input.notes ?? null,
    });
    return row ? toEvalCaseDto(row) : undefined;
  }

  async deleteCase(workspaceId: string, agentId: string, caseId: string): Promise<boolean> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return false;
    const existing = await this.repo.getCase(workspaceId, caseId);
    if (!existing || existing.ownerId !== agentId) return false;
    return this.repo.deleteCase(workspaceId, caseId);
  }

  /**
   * Derive a case from a judged finding (contract §4.4), fully offline.
   * Returns `undefined` when the finding doesn't resolve in this workspace
   * (route → 404). `created: false` signals the idempotent re-click path
   * (step 7 — route → 200); `created: true` is a fresh case (route → 201).
   */
  async createCaseFromFinding(
    workspaceId: string,
    findingId: string,
  ): Promise<{ case: EvalCase; created: boolean } | undefined> {
    const ctx = await this.repo.findingContext(findingId);
    if (!ctx) return undefined;
    const { finding, review, pull } = ctx;
    if (review.workspaceId !== workspaceId) return undefined;

    const ownerId = review.agentId;
    if (!ownerId) {
      throw new ValidationError('finding has no owning agent');
    }

    // Idempotency (step 7) is checked BEFORE the agent-exists check: an
    // already-existing case must keep returning 200 even if its owning
    // agent was deleted afterward (cases cascade from workspace_id, not
    // from the agent — see server/INSIGHTS.md 2026-08-25 edge case).
    const existing = await this.repo.getCaseBySourceFinding(workspaceId, ownerId, findingId);
    if (existing) return { case: toEvalCaseDto(existing), created: false };

    const agent = await this.repo.getAgentById(ownerId);
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new ValidationError('agent that produced this finding no longer exists');
    }

    let kind: 'must_find' | 'must_not_flag';
    if (finding.acceptedAt) kind = 'must_find';
    else if (finding.dismissedAt) kind = 'must_not_flag';
    else throw new ValidationError('finding has no accept/dismiss decision');

    const expectedOutput: EvalExpectation = EvalExpectationSchema.parse({
      kind,
      file: finding.file,
      start_line: finding.startLine,
      end_line: finding.endLine,
      severity: finding.severity as Severity,
      category: finding.category as FindingCategory,
      title: finding.title,
    });

    const prFiles = await this.repo.getPrFilesForPath(pull.id, finding.file);
    const withPatch = prFiles.find((f) => f.patch);
    if (!withPatch) {
      throw new ValidationError(`no stored patch for ${finding.file}`);
    }
    const inputDiff = assembleDiffFragment([{ path: finding.file, patch: withPatch.patch }]);

    const existingNames = new Set(
      (await this.repo.listCasesForOwner(workspaceId, ownerId)).map((c) => c.name),
    );
    const name = dedupeCaseName(slugify(finding.title), existingNames);

    const meta: EvalCaseMeta = {
      origin: 'finding',
      source_finding_id: finding.id,
      source_pr_id: pull.id,
      source_review_id: review.id,
    };

    const row = await this.repo.insertCase({
      workspaceId,
      ownerId,
      name,
      inputDiff,
      inputFiles: null,
      inputMeta: meta,
      expectedOutput,
      notes: null,
    });

    return { case: toEvalCaseDto(row), created: true };
  }

  // ---- runs (§4.1, §4.5, §4.6) ------------------------------------------------

  /**
   * Replay an agent's eval set as one batch. Cases run SEQUENTIALLY — provider
   * rate limits preclude parallelism (precedent: `AgentsService.evaluateSkillsAB`).
   * A case that fails to parse or whose review call throws is recorded with an
   * error and does not stop the batch (§4.6). Returns `undefined` when the
   * agent is unknown in this workspace (route → 404).
   */
  async runBatch(
    workspaceId: string,
    agentId: string,
    caseIds?: string[],
  ): Promise<EvalBatchDetail | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;

    const cases =
      caseIds && caseIds.length > 0
        ? await this.repo.getCasesByIds(workspaceId, agentId, caseIds)
        : await this.repo.listCasesForOwner(workspaceId, agentId);

    if (cases.length === 0) {
      throw new ValidationError('agent has no eval cases');
    }

    const skillBodies = await this.repo.enabledSkillBodiesForAgent(agentId);
    const llm = await this.container.llm(agent.provider as Provider);

    const batch = await this.repo.insertBatch({
      workspaceId,
      ownerId: agentId,
      agentVersion: agent.version,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      provider: agent.provider,
      casesTotal: cases.length,
    });

    const startAll = Date.now();

    // ---- phase 1: replay every case through the real review path (one LLM
    // call per case, sequential; provider rate limits preclude parallelism —
    // precedent `evaluateSkillsAB`). This phase never calls into the scorer. --
    const replays: CaseReplay[] = [];
    for (const evalCase of cases) {
      const caseStart = Date.now();
      const expectation = EvalExpectationSchema.parse(evalCase.expectedOutput);

      try {
        const diff = parseUnifiedDiff(evalCase.inputDiff ?? '');
        if (diff.files.length === 0) {
          replays.push({
            caseId: evalCase.id,
            expectation,
            errorMessage: 'diff fragment parsed to zero files',
            durationMs: Date.now() - caseStart,
          });
          continue;
        }

        // Deliberately NOT passed: callers, repoMap, specs, prDescription
        // (contract §4.5) — a synthetic diff has no repository behind it,
        // and their omission is what keeps two batches comparable.
        const outcome = await reviewPullRequest({
          systemPrompt: agent.systemPrompt,
          model: agent.model,
          diff,
          llm,
          strategy: agent.strategy ?? 'auto',
          ...(skillBodies.length > 0 ? { skills: skillBodies } : {}),
          // Slugified at the point of use, not merely at creation. `task` is
          // the ONE user-prompt section `reviewer-core/src/prompt.ts` does not
          // pass through `wrapUntrusted` (prompt.ts:105), and a Case Editor
          // name is free text (`EvalCaseManualInput.name` is a bare string),
          // so an unsanitised name would land unfenced in the model's prompt.
          // Finding-derived names are already slugs, so this is a no-op there.
          task: `Eval case · ${slugify(evalCase.name)}`,
          sessionId: `eval:${agentId}:${batch.id}`,
        });

        replays.push({
          caseId: evalCase.id,
          expectation,
          outcome,
          durationMs: Date.now() - caseStart,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        replays.push({
          caseId: evalCase.id,
          expectation,
          errorMessage: message,
          durationMs: Date.now() - caseStart,
        });
      }
    }

    // ---- phase 2: deterministic, zero-LLM-call scoring (contract §3) over
    // every case's recorded outcome, then persistence. No LLM call happens
    // anywhere below this line. ---------------------------------------------
    let anySucceeded = false;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;
    let hasCost = false;
    const scoreInputs: EvalCaseScoreInput[] = [];

    // Per-case `precision` / `citation_accuracy` are scored by running the
    // batch scorer over a one-element set. Reusing `scoreBatch` rather than
    // adding a per-case metric API keeps one definition of each ratio: a
    // case's row and the batch it belongs to can never disagree.
    //
    // `recall` deliberately stays null on the row. Its per-case denominator is
    // the case's own single expectation, so it degenerates to 0/1 for
    // `must_find` — already carried by `pass` — and is undefined for
    // `must_not_flag`. Writing it would add a column that is either redundant
    // or permanently blank.
    for (const replay of replays) {
      if (replay.errorMessage) {
        const failed: FailedActualOutput = { error: replay.errorMessage };
        const input: EvalCaseScoreInput = {
          expectation: replay.expectation,
          findings: [],
          kept: 0,
          dropped: 0,
        };
        const single = scoreBatch([input]);
        await this.repo.insertRun({
          caseId: replay.caseId,
          batchId: batch.id,
          actualOutput: failed,
          pass: false,
          precision: single.precision,
          citationAccuracy: single.citation_accuracy,
          durationMs: replay.durationMs,
          costUsd: null,
        });
        scoreInputs.push(input);
        continue;
      }

      const outcome = replay.outcome!;
      anySucceeded = true;
      totalTokensIn += outcome.tokensIn;
      totalTokensOut += outcome.tokensOut;
      if (outcome.costUsd != null) {
        totalCostUsd += outcome.costUsd;
        hasCost = true;
      }

      const caseScore = scoreCase(replay.expectation, outcome.review.findings);
      const completed: CompletedActualOutput = {
        findings: outcome.review.findings,
        dropped: outcome.dropped.length,
        grounding: outcome.grounding,
        matched_finding_id: caseScore.matchedFindingId,
      };
      const input: EvalCaseScoreInput = {
        expectation: replay.expectation,
        findings: outcome.review.findings,
        kept: outcome.review.findings.length,
        dropped: outcome.dropped.length,
      };
      const single = scoreBatch([input]);
      await this.repo.insertRun({
        caseId: replay.caseId,
        batchId: batch.id,
        actualOutput: completed,
        pass: caseScore.pass,
        precision: single.precision,
        citationAccuracy: single.citation_accuracy,
        durationMs: replay.durationMs,
        costUsd: outcome.costUsd,
      });
      scoreInputs.push(input);
    }

    const batchScore = scoreBatch(scoreInputs);
    const totalDurationMs = Date.now() - startAll;

    const finished = await this.repo.finishBatch(batch.id, {
      status: anySucceeded ? 'succeeded' : 'failed',
      finishedAt: new Date(),
      tracesPassed: batchScore.traces_passed,
      recall: batchScore.recall,
      precision: batchScore.precision,
      citationAccuracy: batchScore.citation_accuracy,
      durationMs: totalDurationMs,
      costUsd: hasCost ? totalCostUsd : null,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      error: null,
    });
    const finalBatch = finished ?? batch;

    const runs = await this.repo.listRunsForBatch(batch.id);
    return {
      batch: toEvalBatchRecordDto(finalBatch),
      system_prompt: finalBatch.systemPrompt,
      cases: runs.map(toEvalRunRecordDto),
    };
  }

  async listBatches(
    workspaceId: string,
    agentId: string,
    limit = DEFAULT_RUNS_LIMIT,
  ): Promise<ReturnType<typeof toEvalBatchRecordDto>[] | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;
    const cappedLimit = Math.min(limit, MAX_RUNS_LIMIT);
    const rows = await this.repo.listBatches(workspaceId, agentId, cappedLimit);
    return rows.map(toEvalBatchRecordDto);
  }

  async getBatchDetail(
    workspaceId: string,
    agentId: string,
    batchId: string,
  ): Promise<EvalBatchDetail | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;
    const batch = await this.repo.getBatch(workspaceId, agentId, batchId);
    if (!batch) return undefined;
    const runs = await this.repo.listRunsForBatch(batch.id);
    return {
      batch: toEvalBatchRecordDto(batch),
      system_prompt: batch.systemPrompt,
      cases: runs.map(toEvalRunRecordDto),
    };
  }

  async compareBatches(
    workspaceId: string,
    agentId: string,
    aId: string,
    bId: string,
  ): Promise<EvalRunComparison | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;
    const [rowA, rowB] = await Promise.all([
      this.repo.getBatch(workspaceId, agentId, aId),
      this.repo.getBatch(workspaceId, agentId, bId),
    ]);
    if (!rowA || !rowB) return undefined;

    // `a` is always the older run (§4.1).
    const [older, newer] = rowA.ranAt.getTime() <= rowB.ranAt.getTime() ? [rowA, rowB] : [rowB, rowA];

    return {
      a: toEvalBatchRecordDto(older),
      b: toEvalBatchRecordDto(newer),
      system_prompt_a: older.systemPrompt,
      system_prompt_b: newer.systemPrompt,
      delta: {
        recall: metricDelta(newer.recall, older.recall),
        precision: metricDelta(newer.precision, older.precision),
        citation_accuracy: metricDelta(newer.citationAccuracy, older.citationAccuracy),
        cost_usd: metricDelta(newer.costUsd, older.costUsd),
      },
    };
  }

  // ---- dashboard (§4.3) -------------------------------------------------------

  async getDashboardIndex(workspaceId: string): Promise<EvalDashboardIndex> {
    const agentRows = await this.repo.listAgentsForWorkspace(workspaceId);

    const agents: EvalDashboardAgentSummary[] = [];
    for (const agent of agentRows) {
      const [casesTotal, batches] = await Promise.all([
        this.repo.countCasesForOwner(workspaceId, agent.id),
        this.repo.listAllBatchesForOwner(workspaceId, agent.id),
      ]);
      agents.push({
        agent_id: agent.id,
        agent_name: agent.name,
        model: agent.model,
        cases_total: casesTotal,
        last_run: batches[0] ? toEvalBatchRecordDto(batches[0]) : null,
        trend: buildTrend(batches),
      });
    }

    const recentRows = await this.repo.listRecentBatchesAcrossOwners(
      workspaceId,
      DASHBOARD_RECENT_RUNS_LIMIT,
    );
    const recent_runs = recentRows.map((r) => ({
      ...toEvalBatchRecordDto(r),
      agent_name: r.agentName,
    }));

    return { agents, recent_runs };
  }

  async getAgentDashboard(workspaceId: string, agentId: string): Promise<EvalDashboard | undefined> {
    const agent = await this.repo.getAgent(workspaceId, agentId);
    if (!agent) return undefined;

    const [casesTotal, batches] = await Promise.all([
      this.repo.countCasesForOwner(workspaceId, agentId),
      this.repo.listAllBatchesForOwner(workspaceId, agentId), // newest-first
    ]);
    const newest = batches[0];
    const previous = batches[1];

    const current = newest
      ? {
          recall: newest.recall,
          precision: newest.precision,
          citation_accuracy: newest.citationAccuracy,
          traces_passed: newest.tracesPassed,
          traces_total: newest.casesTotal,
          cost_usd: newest.costUsd,
        }
      : {
          recall: null,
          precision: null,
          citation_accuracy: null,
          traces_passed: 0,
          traces_total: 0,
          cost_usd: null,
        };

    const delta = {
      recall: metricDelta(newest?.recall ?? null, previous?.recall ?? null),
      precision: metricDelta(newest?.precision ?? null, previous?.precision ?? null),
      citation_accuracy: metricDelta(
        newest?.citationAccuracy ?? null,
        previous?.citationAccuracy ?? null,
      ),
    };
    if (!previous) {
      delta.recall = null;
      delta.precision = null;
      delta.citation_accuracy = null;
    }

    return {
      owner_kind: 'agent',
      owner_id: agentId,
      cases_total: casesTotal,
      current,
      delta,
      trend: buildTrend(batches),
      recent_runs: batches.slice(0, DASHBOARD_RECENT_RUNS_LIMIT).map(toEvalBatchRecordDto),
      alert: computeAlert(newest, previous),
    };
  }
}

/** Chronological trend points (§3.4 — a batch with any null metric is
 *  omitted rather than coerced) from newest-first batch rows. */
function buildTrend(batchesNewestFirst: EvalRunBatchRow[]): EvalTrendPoint[] {
  return [...batchesNewestFirst]
    .reverse()
    .filter((b) => b.recall != null && b.precision != null && b.citationAccuracy != null)
    .map((b) => ({
      ran_at: b.ranAt.toISOString(),
      recall: b.recall!,
      precision: b.precision!,
      citation_accuracy: b.citationAccuracy!,
      pass_rate: b.casesTotal > 0 ? b.tracesPassed / b.casesTotal : 0,
      cost_usd: b.costUsd,
    }));
}
