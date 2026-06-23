import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getContext } from '../_shared/context.js';
import { NotFoundError } from '../../platform/errors.js';
import { ConventionsService } from './service.js';
import * as t from '../../db/schema.js';

const RepoParams = z.object({ id: z.string().uuid() });
const ScanParams = z.object({ id: z.string().uuid(), scanId: z.string() });
const ConventionParams = z.object({ id: z.string().uuid() });

/**
 * Conventions module routes.
 *   POST  /repos/:id/conventions/extract        → 202 { scan_id }
 *   GET   /repos/:id/conventions/events/:scanId → SSE progress stream
 *   GET   /repos/:id/conventions                → { candidates, scanned_at }
 *   PATCH /conventions/:id                      → updated convention or 404
 *   POST  /repos/:id/conventions/to-skills      → 201 { skills: [...] }
 */
export default async function conventionsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new ConventionsService(app.container);

  // POST /repos/:id/conventions/extract
  app.post(
    '/repos/:id/conventions/extract',
    { schema: { params: RepoParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const repo = await fetchRepo(app.container, workspaceId, req.params.id);
      if (!repo) throw new NotFoundError('Repo not found');
      const scanId = await service.startExtraction(workspaceId, req.params.id, repo);
      reply.status(202);
      return { scan_id: scanId };
    },
  );

  // GET /repos/:id/conventions/events/:scanId — SSE progress stream
  // No rate limit: SSE is one long-lived connection, not burst traffic.
  app.get(
    '/repos/:id/conventions/events/:scanId',
    { schema: { params: ScanParams }, config: { rateLimit: false } },
    async (req, reply) => {
      await getContext(app.container, req);
      const { scanId } = req.params;

      // Bridge the in-memory RunBus to an async iterator the SSE plugin drains.
      // Mirrors the pattern in server/src/modules/reviews/routes.ts.
      reply.sse(
        (async function* () {
          const queue: { seq: number; kind: string }[] = [];
          let resolve: (() => void) | null = null;
          let done = false;

          const unsubscribe = app.container.runBus.subscribe(scanId, (e) => {
            queue.push(e);
            resolve?.();
          });
          const offDone = app.container.runBus.onDone(scanId, () => {
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

  // GET /repos/:id/conventions
  app.get(
    '/repos/:id/conventions',
    {
      schema: {
        params: RepoParams,
        querystring: z.object({ accepted: z.coerce.boolean().optional() }),
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.list(workspaceId, req.params.id, { accepted: req.query.accepted });
    },
  );

  // PATCH /conventions/:id
  app.patch(
    '/conventions/:id',
    {
      schema: {
        params: ConventionParams,
        body: z.object({
          rule: z.string().min(1).max(500).optional(),
          accepted: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const result = await service.update(workspaceId, req.params.id, req.body);
      if (!result) throw new NotFoundError('Convention not found');
      return result;
    },
  );

  // POST /repos/:id/conventions/to-skills
  app.post(
    '/repos/:id/conventions/to-skills',
    {
      schema: {
        params: RepoParams,
        body: z.object({ agent_id: z.string().uuid().optional() }),
      },
    },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const repo = await fetchRepo(app.container, workspaceId, req.params.id);
      if (!repo) throw new NotFoundError('Repo not found');
      const repoSlug = `${repo.owner}-${repo.name}`;
      const result = await service.createSkillsFromConventions(
        workspaceId,
        req.params.id,
        repoSlug,
        req.body.agent_id,
      );
      reply.status(201);
      return result;
    },
  );
}

/** Fetch repo metadata needed for extraction. Returns null if not found or wrong workspace. */
async function fetchRepo(
  container: import('../../platform/container.js').Container,
  workspaceId: string,
  repoId: string,
): Promise<{ owner: string; name: string; defaultBranch: string } | null> {
  const [row] = await container.db
    .select()
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
  if (!row) return null;
  return { owner: row.owner, name: row.name, defaultBranch: row.defaultBranch };
}
