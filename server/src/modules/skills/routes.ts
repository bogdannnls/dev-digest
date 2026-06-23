import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SkillType } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
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

const CreateSkillBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  type: SkillType,
  body: z.string().min(1),
  enabled: z.boolean().optional(),
});

const UpdateSkillBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  type: SkillType.optional(),
  body: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  app.get('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.get(workspaceId, req.params.id);
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.get('/skills/:id/usage', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const u = await service.usage(workspaceId, req.params.id);
    if (!u) throw new NotFoundError('Skill not found');
    return u;
  });

  app.post('/skills', { schema: { body: CreateSkillBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.create(workspaceId, req.body);
    reply.status(201);
    return skill;
  });

  app.put(
    '/skills/:id',
    { schema: { params: IdParams, body: UpdateSkillBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const skill = await service.update(workspaceId, req.params.id, req.body);
      if (!skill) throw new NotFoundError('Skill not found');
      return skill;
    },
  );

  app.delete('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ok = await service.delete(workspaceId, req.params.id);
    if (!ok) throw new NotFoundError('Skill not found');
    return { ok: true };
  });

  app.post('/skills/import/preview', async (req) => {
    await getContext(app.container, req);
    const data = await req.file();
    if (!data) {
      throw new ValidationError('No file uploaded.', { code: 'missing_file' });
    }
    if (!data.filename.toLowerCase().endsWith('.md')) {
      throw new ValidationError('File must have a .md extension.', { code: 'wrong_extension' });
    }
    const buffer = await data.toBuffer();
    if (buffer.length > 256 * 1024) {
      throw new ValidationError('File too large (max 256KB).', { code: 'too_large' });
    }
    let text: string;
    try {
      text = buffer.toString('utf8');
    } catch {
      throw new ValidationError('File must be UTF-8 encoded.', { code: 'invalid_encoding' });
    }
    return service.parseImport(text, data.filename);
  });
}
