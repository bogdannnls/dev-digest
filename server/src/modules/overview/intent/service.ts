/**
 * `IntentService` — freshness check, job handler, `getOrCompute`/`refresh`,
 * and server-side rate limits for the Intent Layer.
 * See docs/superpowers/specs/2026-07-04-intent-layer-design.md §8.1, §9.2, §11.3.
 */
import { randomUUID } from 'node:crypto';
import * as t from '../../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { PrIntentResponse, PrIntentStaleReason } from '@devdigest/shared';
import type { Container } from '../../../platform/container.js';
import { NotFoundError, RateLimitedError } from '../../../platform/errors.js';
import { collectReferences } from './references.js';
import { extractIntent } from './extract.js';
import { bodyHashOf, clipDiff } from './helpers.js';
import { IntentRepository } from './repository.js';
import { toReferenceRow } from './types.js';

const JOB_KIND = 'overview.intent';

const WORKSPACE_LIMIT = 30;
const WORKSPACE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PR_REFRESH_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Per-workspace/per-PR compute rate limits.
 *
 * **Not implemented via `@fastify/rate-limit`** — that plugin is disabled
 * entirely under `config.nodeEnv === 'test'` (`server/src/app.ts:103-105`,
 * "per-route overrides live on the routes themselves — but they never fire in
 * tests") and its default keying is per-IP, not per-workspace/per-PR. Instead,
 * this service holds two small in-memory trackers so the limits are exercised
 * identically in prod and test.
 *
 * Trade-off (documented, not silently shipped as "the real" rate limiter):
 * state lives in process memory. It resets on server restart and is not
 * shared across horizontally-scaled instances. Acceptable for the current
 * single-process local-first architecture (spec §11.3 / plan Risks).
 */
export class IntentService {
  private repo: IntentRepository;
  private registered = false;

  /** workspaceId -> timestamps (ms) of computes within the current rolling hour. */
  private workspaceComputeLog = new Map<string, number[]>();
  /** prId -> timestamp (ms) of the last refresh. */
  private lastRefreshAt = new Map<string, number>();

  constructor(
    private container: Container,
    private now: () => number = () => Date.now(),
  ) {
    this.repo = new IntentRepository(container.db);
    this.registerJobHandler();
  }

  /**
   * Read-through cache lookup. Cold (no row) always computes; warm rows are
   * compared against the current freshness key (spec §6.2 drift matrix).
   */
  async getOrCompute(workspaceId: string, prId: string): Promise<PrIntentResponse> {
    const pr = await this.loadPr(workspaceId, prId);
    const wantedKey = { headSha: pr.headSha, bodyHash: bodyHashOf(pr.body) };
    const row = await this.repo.get(prId);

    if (!row) {
      const runId = await this.enqueueCompute(workspaceId, prId);
      return { status: 'computing', runId };
    }

    const staleReasons: PrIntentStaleReason[] = [];
    if (row.headSha !== wantedKey.headSha) staleReasons.push('head_sha');
    if (row.bodyHash !== wantedKey.bodyHash) staleReasons.push('body');

    if (staleReasons.length === 0) return { status: 'ready', data: row.data };
    return { status: 'ready-stale', data: row.data, staleReasons };
  }

  /** Always enqueues a recompute, regardless of freshness. Rate-limited 1/min/PR. */
  async refresh(workspaceId: string, prId: string): Promise<{ runId: string }> {
    await this.loadPr(workspaceId, prId);
    this.checkPrRefreshLimit(prId);
    const runId = await this.enqueueCompute(workspaceId, prId);
    return { runId };
  }

  /** Cache-miss enqueue path shared by `getOrCompute` and `refresh`. */
  private async enqueueCompute(workspaceId: string, prId: string): Promise<string> {
    this.checkWorkspaceLimit(workspaceId);
    const runId = randomUUID();
    await this.container.jobs.enqueue(workspaceId, JOB_KIND, { workspaceId, prId, runId });
    return runId;
  }

  private checkWorkspaceLimit(workspaceId: string): void {
    const now = this.now();
    const cutoff = now - WORKSPACE_WINDOW_MS;
    const timestamps = (this.workspaceComputeLog.get(workspaceId) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= WORKSPACE_LIMIT) {
      const oldest = Math.min(...timestamps);
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WORKSPACE_WINDOW_MS - now) / 1000));
      throw new RateLimitedError(
        `Workspace compute limit reached (${WORKSPACE_LIMIT}/hour). Try again later.`,
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
      throw new RateLimitedError('You just refreshed this PR. Try again shortly.', {
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
   * Registers the `overview.intent` job handler once per service instance.
   * Follows spec §8.1 exactly: publish `info` progress, collect references,
   * extract intent, THEN commit the DB write (`repo.upsert`), THEN publish
   * `'done'` — only after the write resolves — THEN `bus.complete(runId)` in
   * a `finally` (cross-cutting insight: SSE 'done' must be emitted by the
   * layer that commits the side effect, not the layer that produces the data).
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
      try {
        bus.publish(runId, 'info', 'Loading PR');
        const pr = await this.loadPr(workspaceId, prId);

        const [repoRow] = await this.container.db
          .select()
          .from(t.repos)
          .where(eq(t.repos.id, pr.repoId));
        if (!repoRow) throw new NotFoundError('Repo not found');

        bus.publish(runId, 'info', 'Loading diff');
        const files = await this.container.db
          .select()
          .from(t.prFiles)
          .where(eq(t.prFiles.prId, prId));
        const diffSummary = clipDiff(files);

        bus.publish(runId, 'info', 'Collecting references');
        const references = await collectReferences(
          this.container,
          workspaceId,
          pr.body ?? '',
          repoRow.owner,
          repoRow.name,
          (msg) => bus.publish(runId, 'info', msg),
        );

        bus.publish(runId, 'info', 'Extracting intent');
        const result = await extractIntent(this.container, workspaceId, {
          title: pr.title,
          body: pr.body ?? '',
          diffSummary,
          references,
        });

        // Commit the side effect BEFORE emitting 'done' — a UI that
        // invalidates its query on 'done' must never race the write.
        await this.repo.upsert(
          prId,
          { headSha: pr.headSha, bodyHash: bodyHashOf(pr.body) },
          result,
          references.map(toReferenceRow),
        );

        bus.publish(runId, 'done', 'Intent ready', {
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        });
      } catch (err) {
        bus.publish(runId, 'error', (err as Error).message);
      } finally {
        bus.complete(runId);
      }
    });
  }
}
