import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { SkillsService } from './service.js';

/**
 * Skills module.
 *   GET    /skills              → list (workspace-scoped)
 *   GET    /skills/:id          → one skill
 *   GET    /skills/:id/usage    → { agent_count }
 *   POST   /skills              → create
 *   PUT    /skills/:id          → update
 *   DELETE /skills/:id          → delete
 */
export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });
}
