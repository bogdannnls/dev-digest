import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrOverviewBriefResponse } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { OverviewService } from './service.js';

/**
 * PR Overview tab — Slice A.
 *   GET /pulls/:id/overview/brief → PrOverviewBriefResponse
 *
 * Pure aggregation over existing reviews + findings + agent_runs.
 * No cache, no LLM. Subsequent slices add Intent / Blast Radius / Prior PRs.
 */
export default async function overviewRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new OverviewService(container);

  app.get(
    '/pulls/:id/overview/brief',
    { schema: { params: IdParams } },
    async (req): Promise<PrOverviewBriefResponse> => {
      const { workspaceId } = await getContext(container, req);
      return service.getBrief(workspaceId, req.params.id);
    },
  );
}
