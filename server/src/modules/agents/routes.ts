import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CiFailOn, Provider, ReviewStrategy } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { AgentsService } from './service.js';
import { PRFixtureMeta, SkillsEvalResult } from '../../vendor/shared/contracts/knowledge.js';
import { listFixtures } from './eval-fixtures.js';

/** `/providers/:id` addresses a provider by name, not a uuid. */
const ProviderParams = z.object({ id: Provider });

/** `/agents/:id/versions/:version` — id is a uuid, version a positive integer. */
const VersionParams = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

/**
 * A2 — agents module (owner A2).
 *   GET    /agents                  → list (workspace-scoped)
 *   GET    /agents/:id              → one agent
 *   POST   /agents                  → create
 *   PUT    /agents/:id              → update / toggle enabled (versions config)
 *   GET    /agents/:id/versions     → config history (newest first)
 *   GET    /agents/:id/versions/:version → one config snapshot
 *   GET    /agents/:id/skills       → linked skills (ordered)
 *   POST   /agents/:id/skills       → set/reorder linked skills OR link one
 *   GET    /agents/:id/models       → dynamic model list for the agent's provider
 *   GET    /providers/:id/models    → dynamic model list for a provider (editor)
 */

const CreateAgentBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  provider: Provider,
  model: z.string().min(1),
  system_prompt: z.string().min(1),
  output_schema: z.unknown().optional(),
  strategy: ReviewStrategy.optional(),
  ci_fail_on: CiFailOn.optional(),
  repo_intel: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const UpdateAgentBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    provider: Provider.optional(),
    model: z.string().min(1).optional(),
    system_prompt: z.string().min(1).optional(),
    output_schema: z.unknown().optional(),
    strategy: ReviewStrategy.optional(),
    ci_fail_on: CiFailOn.optional(),
    repo_intel: z.boolean().optional(),
    enabled: z.boolean().optional(),
    attached_context_paths: z.array(z.string()).optional(),
    // Transient — never persisted, not part of `Agent`/`UpdateAgentInput`/the
    // DB. Resolves AC-12/AC-12c's "governing repo": the workspace's
    // currently-active repo selection at save time, used ONLY to validate
    // `attached_context_paths` against a freshly-computed discovery set.
    repo_id: z.string().uuid().optional(),
  })
  .refine((b) => b.attached_context_paths === undefined || b.repo_id !== undefined, {
    message: 'repo_id is required when attached_context_paths is present',
    path: ['repo_id'],
  });

/** Either set the whole ordered set (`skill_ids`) or link one (`skill_id`). */
const SetSkillsBody = z
  .object({
    skill_ids: z.array(z.string().uuid()).optional(),
    skill_id: z.string().uuid().optional(),
    order: z.number().int().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => b.skill_ids !== undefined || b.skill_id !== undefined, {
    message: 'Provide skill_ids (set/reorder) or skill_id (link one)',
  });

const SkillLinkParams = z.object({
  id: z.string().uuid(),
  skillId: z.string().uuid(),
});

const ToggleSkillEnabledBody = z.object({ enabled: z.boolean() });

export default async function agentsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new AgentsService(app.container);

  app.get('/agents', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  // ---- GET /agents/eval-fixtures -----------------------------------------------
  // MUST be registered before GET /agents/:id or Fastify will route "eval-fixtures"
  // as an :id and fail UUID validation.
  app.route({
    method: 'GET',
    url: '/agents/eval-fixtures',
    schema: { response: { 200: z.array(PRFixtureMeta) } },
    handler: async () => {
      return listFixtures();
    },
  });

  app.get('/agents/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const agent = await service.get(workspaceId, req.params.id);
    if (!agent) throw new NotFoundError('Agent not found');
    return agent;
  });

  app.post('/agents', { schema: { body: CreateAgentBody } }, async (req, reply) => {
    const { workspaceId, userId } = await getContext(app.container, req);
    const body = req.body;
    const agent = await service.create(
      workspaceId,
      {
        name: body.name,
        provider: body.provider,
        model: body.model,
        system_prompt: body.system_prompt,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.output_schema !== undefined ? { output_schema: body.output_schema } : {}),
        ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
        ...(body.ci_fail_on !== undefined ? { ci_fail_on: body.ci_fail_on } : {}),
        ...(body.repo_intel !== undefined ? { repo_intel: body.repo_intel } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
      userId,
    );
    reply.status(201);
    return agent;
  });

  app.put(
    '/agents/:id',
    { schema: { params: IdParams, body: UpdateAgentBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      // `repo_id` is transient (AC-12c's governing-repo selector) — never
      // forwarded as part of the persisted patch.
      const { repo_id, ...patch } = req.body;
      const agent = await service.update(workspaceId, req.params.id, patch, repo_id);
      if (!agent) throw new NotFoundError('Agent not found');
      return agent;
    },
  );

  app.delete('/agents/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ok = await service.delete(workspaceId, req.params.id);
    if (!ok) throw new NotFoundError('Agent not found');
    return { ok: true };
  });

  app.get('/agents/:id/versions', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const versions = await service.listVersions(workspaceId, req.params.id);
    if (!versions) throw new NotFoundError('Agent not found');
    return versions;
  });

  app.get(
    '/agents/:id/versions/:version',
    { schema: { params: VersionParams } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const version = await service.getVersion(workspaceId, req.params.id, req.params.version);
      if (!version) throw new NotFoundError('Agent version not found');
      return version;
    },
  );

  app.get('/agents/:id/skills', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const agent = await service.get(workspaceId, req.params.id);
    if (!agent) throw new NotFoundError('Agent not found');
    return service.skillLinks(req.params.id);
  });

  app.post(
    '/agents/:id/skills',
    { schema: { params: IdParams, body: SetSkillsBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const body = req.body;
      const links =
        body.skill_ids !== undefined
          ? await service.setSkills(workspaceId, req.params.id, body.skill_ids)
          : await service.linkSkill(
              workspaceId,
              req.params.id,
              body.skill_id!,
              body.order,
              body.enabled,
            );
      if (!links) throw new NotFoundError('Agent not found');
      return links;
    },
  );

  app.patch(
    '/agents/:id/skills/:skillId',
    { schema: { params: SkillLinkParams, body: ToggleSkillEnabledBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const links = await service.setSkillEnabled(
        workspaceId,
        req.params.id,
        req.params.skillId,
        req.body.enabled,
      );
      if (!links) throw new NotFoundError('Agent or skill link not found');
      return links;
    },
  );

  app.delete(
    '/agents/:id/skills/:skillId',
    { schema: { params: SkillLinkParams } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const links = await service.unlinkSkill(
        workspaceId,
        req.params.id,
        req.params.skillId,
      );
      if (!links) throw new NotFoundError('Agent not found');
      return links;
    },
  );

  app.get('/agents/:id/models', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const agent = await service.get(workspaceId, req.params.id);
    if (!agent) throw new NotFoundError('Agent not found');
    try {
      return await service.listModels(agent.provider);
    } catch (err) {
      req.log.warn({ err, provider: agent.provider }, 'listModels failed');
      return [];
    }
  });

  app.get('/providers/:id/models', { schema: { params: ProviderParams } }, async (req) => {
    await getContext(app.container, req);
    try {
      return await service.listModels(req.params.id);
    } catch (err) {
      req.log.warn({ err, provider: req.params.id }, 'listModels failed');
      return [];
    }
  });

  // ---- POST /agents/:id/skills-eval --------------------------------------------
  const SkillsEvalBody = z.object({ fixture_id: z.string().min(1) });

  app.route({
    method: 'POST',
    url: '/agents/:id/skills-eval',
    schema: {
      params: IdParams,
      body: SkillsEvalBody,
      response: { 200: SkillsEvalResult },
    },
    handler: async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const { id } = req.params;
      const { fixture_id } = req.body;
      const result = await service.evaluateSkillsAB(workspaceId, id, fixture_id);
      if (!result) throw new NotFoundError(`Agent ${id} not found`);
      return result;
    },
  });
}
