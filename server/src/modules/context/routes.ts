/**
 * Project Context HTTP module (L05 T1).
 *
 *   GET  /repos/:id/context           → SpecFile[] (path/size/updated_at; no content) — AC-1, AC-2, AC-4, AC-5, AC-8
 *   GET  /repos/:id/context/file?path → SpecFile (single doc content, for preview)     — AC-3
 *   POST /repos/:id/context/reindex   → SpecFile[] (re-glob, no persistence)           — AC-6
 *
 * Transport only: parses/validates requests, delegates to ContextService.
 * Mirrors how `modules/repo-intel/routes.ts` registers its own `/repos/:id/...`
 * routes from a separate module.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SpecFile } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { ContextService } from './service.js';

const ContextFileQuery = z.object({ path: z.string().min(1) });

export default async function contextRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new ContextService(container);

  app.get(
    '/repos/:id/context',
    { schema: { params: IdParams, response: { 200: z.array(SpecFile) } } },
    async (req): Promise<SpecFile[]> => {
      const { workspaceId } = await getContext(container, req);
      return service.list(workspaceId, req.params.id);
    },
  );

  app.get(
    '/repos/:id/context/file',
    {
      schema: {
        params: IdParams,
        querystring: ContextFileQuery,
        response: { 200: SpecFile },
      },
    },
    async (req): Promise<SpecFile> => {
      const { workspaceId } = await getContext(container, req);
      return service.readOne(workspaceId, req.params.id, req.query.path);
    },
  );

  app.post(
    '/repos/:id/context/reindex',
    { schema: { params: IdParams, response: { 200: z.array(SpecFile) } } },
    async (req): Promise<SpecFile[]> => {
      const { workspaceId } = await getContext(container, req);
      return service.reindex(workspaceId, req.params.id);
    },
  );
}
