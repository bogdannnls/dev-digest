/**
 * `BriefSynthService` — state machine, in-memory rate limits, and the
 * `overview.brief_synth` job handler for the Why + Risk Brief (SPEC-02).
 * Mirrors `overview/intent/service.ts` (`IntentService`) closely — same
 * shape (injectable `now`, independent rate-limit `Map`s, `getOrCompute`/
 * `refresh`, job handler, SSE `done`-after-commit) — but:
 *
 *   - the freshness key has THREE components (`headSha`, latest-reviewId,
 *     `pr_intent.computedAt`), not two, and drives a 5-state response
 *     (`not_ready`/`computing`/`ready`/`ready-stale`/`error`), not 3;
 *   - `not_ready` never cascades a recompute of intent or the review
 *     (AC-16..18) — this service only READS those two upstream layers;
 *   - the `agent_runs` row is created at ENQUEUE time (not inside the job),
 *     and its minted id IS the runId returned to the caller / used on the
 *     bus, so `GET /pulls/:id/runs` shows a row attributable to this exact
 *     run (plan M2 / AC-34) — mirrors `reviews/service.ts`'s `runReview`.
 *
 * See specs/2026-07-13-why-risk-brief-spec.md and
 * docs/superpowers/plans/2026-07-13-why-risk-brief-plan.md (T6).
 */
import { and, eq } from 'drizzle-orm';
import * as t from '../../../db/schema.js';
import type {
  PrWhyRiskBrief,
  PrWhyRiskBriefMissingInput,
  PrWhyRiskBriefResponse,
  PrWhyRiskBriefStaleReason,
} from '@devdigest/shared';
import type { Container } from '../../../platform/container.js';
import { NotFoundError, RateLimitedError, ValidationError } from '../../../platform/errors.js';
import { assembleBriefInput } from './assemble-input.js';
import { synthesizeBrief } from './synthesize.js';
import { postprocessBrief } from './postprocess.js';
import { BriefSynthRepository } from './repository.js';
import { IntentRepository } from '../intent/repository.js';
import { latestReviewForPr } from '../../_shared/latest-review.js';

const JOB_KIND = 'overview.brief_synth';

/**
 * Numerically identical to `IntentService`'s limits (spec Open Questions #1),
 * but tracked in this class's OWN `Map`s below — never shared with Intent's,
 * so exhausting one feature's budget never touches the other's (AC-31).
 */
const WORKSPACE_LIMIT = 30;
const WORKSPACE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PR_REFRESH_WINDOW_MS = 60 * 1000; // 1 minute

export class BriefSynthService {
  private repo: BriefSynthRepository;
  private intentRepo: IntentRepository;
  private registered = false;

  /** workspaceId -> timestamps (ms) of computes/refreshes within the current rolling hour. */
  private workspaceComputeLog = new Map<string, number[]>();
  /** prId -> timestamp (ms) of the last refresh. */
  private lastRefreshAt = new Map<string, number>();

  constructor(
    private container: Container,
    private now: () => number = () => Date.now(),
  ) {
    this.repo = new BriefSynthRepository(container.db);
    this.intentRepo = new IntentRepository(container.db);
    this.registerJobHandler();
  }

  /**
   * Read-through cache lookup. Gates on intent + a qualifying review both
   * existing (AC-16..18, no cascade recompute of either); a cold cache miss
   * enqueues (AC-19); a warm row is compared against the current freshness
   * key (AC-20..25) and served AS-IS when stale — only `refresh` recomputes.
   */
  async getOrCompute(workspaceId: string, prId: string): Promise<PrWhyRiskBriefResponse> {
    const pr = await this.loadPr(workspaceId, prId);
    const intentRow = await this.intentRepo.get(prId);
    const review = await latestReviewForPr(this.container.db, prId);

    if (!intentRow || !review) {
      return { status: 'not_ready', missing: this.missingInputs(intentRow, review) };
    }

    const row = await this.repo.get(prId);
    if (!row) {
      const runId = await this.enqueueCompute(workspaceId, prId);
      return { status: 'computing', runId };
    }

    const staleReasons: PrWhyRiskBriefStaleReason[] = [];
    if (row.basedOn.headSha !== pr.headSha) staleReasons.push('head_sha');
    if (row.basedOn.reviewId !== review.id) staleReasons.push('new_review');
    if (row.basedOn.intentComputedAt !== intentRow.data.computedAt) staleReasons.push('intent');

    const data: PrWhyRiskBrief = { ...row.data, basedOn: row.basedOn };

    if (staleReasons.length === 0) return { status: 'ready', data };
    return { status: 'ready-stale', data, staleReasons };
  }

  /**
   * Always enqueues a recompute when intent + a qualifying review are
   * present (AC-27), ignoring current freshness entirely. Rejects with a 4xx
   * `AppError` — no enqueue, no partial `pr_brief` write — when either is
   * missing (AC-28). Rate-limited 1/min/PR (AC-29) + 30/hr/workspace (AC-30,
   * shared with cold computes via `enqueueCompute`).
   */
  async refresh(workspaceId: string, prId: string): Promise<{ runId: string }> {
    await this.loadPr(workspaceId, prId);
    const intentRow = await this.intentRepo.get(prId);
    const review = await latestReviewForPr(this.container.db, prId);

    if (!intentRow || !review) {
      throw new ValidationError('Cannot refresh: intent and/or a qualifying review is missing', {
        missing: this.missingInputs(intentRow, review),
      });
    }

    this.checkPrRefreshLimit(prId);
    const runId = await this.enqueueCompute(workspaceId, prId);
    return { runId };
  }

  private missingInputs(
    intentRow: unknown,
    review: unknown,
  ): PrWhyRiskBriefMissingInput[] {
    const missing: PrWhyRiskBriefMissingInput[] = [];
    if (!intentRow) missing.push('intent');
    if (!review) missing.push('review');
    return missing;
  }

  /**
   * Cache-miss enqueue path shared by `getOrCompute` and `refresh`. Creates
   * the `agent_runs` row up front (M2) — its minted id becomes the runId
   * used for the job payload, the bus, and the client response, so the run
   * is attributable in `GET /pulls/:id/runs` (AC-34) even before the job
   * itself has produced any tokens/cost. `provider`/`model` are unknown at
   * enqueue time (resolved per-request inside `synthesizeBrief`, per
   * `server/CLAUDE.md`'s "settings-driven state read per request" rule) —
   * `completeAgentRun` fills in the real values on completion.
   */
  private async enqueueCompute(workspaceId: string, prId: string): Promise<string> {
    this.checkWorkspaceLimit(workspaceId);
    const runId = await this.container.reviewRepo.createAgentRun({
      workspaceId,
      agentId: null,
      prId,
      provider: null,
      model: null,
    });
    await this.container.jobs.enqueue(workspaceId, JOB_KIND, { workspaceId, prId, runId });
    return runId;
  }

  private checkWorkspaceLimit(workspaceId: string): void {
    const now = this.now();
    const cutoff = now - WORKSPACE_WINDOW_MS;
    const timestamps = (this.workspaceComputeLog.get(workspaceId) ?? []).filter((ts) => ts > cutoff);
    if (timestamps.length >= WORKSPACE_LIMIT) {
      const oldest = Math.min(...timestamps);
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WORKSPACE_WINDOW_MS - now) / 1000));
      throw new RateLimitedError(
        `Workspace brief-synth compute limit reached (${WORKSPACE_LIMIT}/hour). Try again later.`,
        { retryAfterSeconds },
      );
    }
    timestamps.push(now);
    this.workspaceComputeLog.set(workspaceId, timestamps);
  }

  private checkPrRefreshLimit(prId: string): void {
    const now = this.now();
    const last = this.lastRefreshAt.get(prId);
    if (last !== undefined && now - last < PR_REFRESH_WINDOW_MS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((last + PR_REFRESH_WINDOW_MS - now) / 1000));
      throw new RateLimitedError('You just refreshed this brief. Try again shortly.', {
        retryAfterSeconds,
      });
    }
    this.lastRefreshAt.set(prId, now);
  }

  private async loadPr(workspaceId: string, prId: string) {
    const [pr] = await this.container.db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    if (!pr) throw new NotFoundError('PR not found');
    return pr;
  }

  /**
   * Registers the `overview.brief_synth` job handler once per service
   * instance. Pipeline: `assembleBriefInput` (T3) -> `synthesizeBrief` ONCE
   * (T5, AC-10) -> `postprocessBrief` (T12 — findingId drop, cap-8,
   * riskLevel floor, risks/fileRef) -> commit `repo.upsert` (T4, all
   * columns, AC-38) -> `completeAgentRun` -> THEN publish `'done'` — only
   * after the DB write commits (AC-33), exactly like `IntentService` (see
   * server/INSIGHTS.md 2026-06-24, "SSE 'done' must be emitted by the layer
   * that commits the side effect").
   */
  private registerJobHandler(): void {
    if (this.registered) return;
    this.registered = true;

    this.container.jobs.register(JOB_KIND, async (payload) => {
      const { workspaceId, prId, runId } = payload as {
        workspaceId: string;
        prId: string;
        runId: string;
      };
      const bus = this.container.runBus;
      const startedAt = this.now();

      try {
        bus.publish(runId, 'info', 'Assembling brief input');
        const input = await assembleBriefInput(this.container, workspaceId, prId);

        bus.publish(runId, 'info', 'Synthesizing brief');
        const synthResult = await synthesizeBrief(this.container, workspaceId, input);

        const postprocessed = postprocessBrief(synthResult.data, {
          findings: input.findings,
          riskAreas: input.intent.riskAreas,
        });

        // Commit the side effect BEFORE emitting 'done' — a UI that
        // invalidates its query on 'done' must never race the write.
        await this.repo.upsert(
          prId,
          {
            headSha: input.basedOn.headSha,
            reviewId: input.basedOn.reviewId,
            intentComputedAt: input.basedOn.intentComputedAt,
          },
          {
            dto: postprocessed,
            tokensIn: synthResult.tokensIn,
            tokensOut: synthResult.tokensOut,
            costUsd: synthResult.costUsd,
            model: synthResult.model,
          },
        );

        await this.container.reviewRepo.completeAgentRun(runId, {
          status: 'done',
          durationMs: this.now() - startedAt,
          tokensIn: synthResult.tokensIn,
          tokensOut: synthResult.tokensOut,
          // Review-specific fields with no meaning for this feature (M2 sentinels).
          findingsCount: 0,
          grounding: 'n/a',
        });

        bus.publish(runId, 'done', 'Brief ready', {
          model: synthResult.model,
          tokensIn: synthResult.tokensIn,
          tokensOut: synthResult.tokensOut,
        });
      } catch (err) {
        const message = (err as Error).message;
        try {
          await this.container.reviewRepo.completeAgentRun(runId, {
            status: 'failed',
            durationMs: this.now() - startedAt,
            tokensIn: 0,
            tokensOut: 0,
            findingsCount: 0,
            grounding: 'n/a',
            error: message,
          });
        } catch {
          // Best-effort: the original failure is still reported via the SSE
          // 'error' event below regardless of whether this write succeeds.
        }
        bus.publish(runId, 'error', message);
      } finally {
        bus.complete(runId);
      }
    });
  }
}
