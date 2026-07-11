import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrOverviewBriefResponse, PrIntentResponse, RunEvent } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { OverviewService } from './service.js';
import { IntentService } from './intent/service.js';

/**
 * PR Overview tab — Slice A + Intent Layer (P1).
 *   GET  /pulls/:id/overview/brief            → PrOverviewBriefResponse
 *   GET  /pulls/:id/overview/intent           → PrIntentResponse (read-through cache)
 *   GET  /pulls/:id/overview/intent/stream    → SSE stream of RunEvent for a compute/refresh run
 *   POST /pulls/:id/overview/intent/refresh   → force recompute; 202 + { runId }
 *
 * Slice A is pure aggregation over existing reviews + findings + agent_runs
 * (no cache, no LLM). The Intent routes below add a read-through cached
 * LLM-derived card; see docs/superpowers/specs/2026-07-04-intent-layer-design.md.
 */
const IntentStreamQuery = z.object({ runId: z.string() });

export default async function overviewRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new OverviewService(container);
  const intentService = new IntentService(container);

  app.get(
    '/pulls/:id/overview/brief',
    { schema: { params: IdParams } },
    async (req): Promise<PrOverviewBriefResponse> => {
      const { workspaceId } = await getContext(container, req);
      return service.getBrief(workspaceId, req.params.id);
    },
  );

  // ---- Intent: read-through cache lookup -----------------------------
  app.get(
    '/pulls/:id/overview/intent',
    { schema: { params: IdParams } },
    async (req): Promise<PrIntentResponse> => {
      const { workspaceId } = await getContext(container, req);
      return intentService.getOrCompute(workspaceId, req.params.id);
    },
  );

  // ---- Intent: force recompute (rate-limited 1/min/PR, 30/hr/workspace) ----
  // RateLimitedError extends AppError (statusCode 429) — the app's global
  // error handler maps it to the HTTP response with no special-casing here.
  app.post(
    '/pulls/:id/overview/intent/refresh',
    { schema: { params: IdParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const { runId } = await intentService.refresh(workspaceId, req.params.id);
      reply.status(202);
      return { runId };
    },
  );

  // ---- Intent: SSE stream of the compute/refresh run -----------------
  // No rate limit: SSE is one long-lived connection, not burst traffic.
  // Bridges the in-memory RunBus to an async iterator, same pattern as
  // reviews/routes.ts's `/runs/:id/events`.
  app.get(
    '/pulls/:id/overview/intent/stream',
    { schema: { params: IdParams, querystring: IntentStreamQuery }, config: { rateLimit: false } },
    async (req, reply) => {
      await getContext(container, req);
      const { runId } = req.query;

      reply.sse(
        (async function* () {
          const queue: RunEvent[] = [];
          let resolve: (() => void) | null = null;
          let done = false;

          const unsubscribe = container.runBus.subscribe(runId, (e) => {
            queue.push(e);
            resolve?.();
          });
          const offDone = container.runBus.onDone(runId, () => {
            done = true;
            resolve?.();
          });

          try {
            while (true) {
              if (queue.length === 0) {
                if (done) break;
                await new Promise<void>((r) => (resolve = r));
                resolve = null;
                continue;
              }
              const e = queue.shift()!;
              yield {
                id: String(e.seq),
                event: e.kind,
                data: JSON.stringify(e),
              };
            }
          } finally {
            unsubscribe();
            offDone();
          }
        })(),
      );
    },
  );
}
