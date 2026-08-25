import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EvalCase,
  EvalCaseManualInput,
  EvalBatchDetail,
  EvalBatchRecord,
  EvalDashboard,
  EvalDashboardIndex,
  EvalRunComparison,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { EvalService } from './service.js';

/**
 * L06 — eval module (owner L06). Layout mirrors the agents domain module.
 * Every handler resolves `workspaceId` via `getContext`; every error path
 * throws a typed class from `platform/errors.ts`.
 *
 *   Runs (§4.1):
 *   POST   /agents/:id/eval-runs             → run the whole set (or a
 *                                               `case_ids` subset) as one batch
 *   GET    /agents/:id/eval-runs              → batch history, newest-first
 *   GET    /agents/:id/eval-runs/compare      → two batches side by side
 *   GET    /agents/:id/eval-runs/:batchId     → one batch's detail
 *
 *   Cases (§4.2):
 *   GET    /agents/:id/eval-cases                  → the agent's case set
 *   POST   /eval-cases/from-finding                 → derive a case (idempotent);
 *                                                      NOT agent-scoped (v1.4 contract
 *                                                      change) — the owning agent is
 *                                                      derived server-side from
 *                                                      finding -> review.agent_id
 *   POST   /agents/:id/eval-cases                   → hand-authored case
 *   PUT    /agents/:id/eval-cases/:caseId           → replace a case
 *   DELETE /agents/:id/eval-cases/:caseId           → remove a case
 *
 *   Dashboard (§4.3):
 *   GET    /eval-dashboard           → every agent's summary + cross-agent recent runs
 *   GET    /eval-dashboard/:agentId  → one agent's aggregate metrics + trend
 *
 * Route-ordering trap (precedent: the agents module's eval-fixtures route): the
 * literal `.../eval-runs/compare` segment is registered before its sibling
 * `/:batchId` route.
 */

const RunBatchBody = z.object({ case_ids: z.array(z.string().uuid()).optional() });

const FromFindingBody = z.object({ finding_id: z.string().uuid() });

const CaseParams = z.object({ id: z.string().uuid(), caseId: z.string().uuid() });

const BatchParams = z.object({ id: z.string().uuid(), batchId: z.string().uuid() });

const CompareQuery = z.object({ a: z.string().uuid(), b: z.string().uuid() });

/** `?limit=` — a non-positive value is a 422 at the boundary; capping at 100
 *  happens in the service (contract §4.1 / spec edge cases). */
const RunsListQuery = z.object({ limit: z.coerce.number().int().positive().optional() });

const AgentIdParams = z.object({ agentId: z.string().uuid() });

export default async function evalRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new EvalService(app.container);

  // ==== Runs (§4.1) ==========================================================

  app.route({
    method: 'POST',
    url: '/agents/:id/eval-runs',
    schema: { params: IdParams, body: RunBatchBody, response: { 201: EvalBatchDetail } },
    handler: async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const detail = await service.runBatch(workspaceId, req.params.id, req.body.case_ids);
      if (!detail) throw new NotFoundError('Agent not found');
      reply.status(201);
      return detail;
    },
  });

  app.get(
    '/agents/:id/eval-runs',
    { schema: { params: IdParams, querystring: RunsListQuery, response: { 200: z.array(EvalBatchRecord) } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const rows = await service.listBatches(workspaceId, req.params.id, req.query.limit);
      if (!rows) throw new NotFoundError('Agent not found');
      return rows;
    },
  );

  // MUST be registered before GET /agents/:id/eval-runs/:batchId or Fastify
  // would need to disambiguate "compare" from a uuid batch id.
  app.get(
    '/agents/:id/eval-runs/compare',
    { schema: { params: IdParams, querystring: CompareQuery, response: { 200: EvalRunComparison } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const comparison = await service.compareBatches(
        workspaceId,
        req.params.id,
        req.query.a,
        req.query.b,
      );
      if (!comparison) throw new NotFoundError('Eval run batch not found');
      return comparison;
    },
  );

  app.get(
    '/agents/:id/eval-runs/:batchId',
    { schema: { params: BatchParams, response: { 200: EvalBatchDetail } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const detail = await service.getBatchDetail(workspaceId, req.params.id, req.params.batchId);
      if (!detail) throw new NotFoundError('Eval run batch not found');
      return detail;
    },
  );

  // ==== Cases (§4.2) ==========================================================

  app.get(
    '/agents/:id/eval-cases',
    { schema: { params: IdParams, response: { 200: z.array(EvalCase) } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const cases = await service.listCases(workspaceId, req.params.id);
      if (!cases) throw new NotFoundError('Agent not found');
      return cases;
    },
  );

  // v1.4 (contract §4.2): NOT agent-scoped — a single literal top-level route,
  // no `:id` sibling to order against. The owning agent is derived
  // server-side from finding -> review.agent_id (service.createCaseFromFinding);
  // the client cannot supply it (FindingsPanel renders findings from several
  // agents' reviews, so no single agentId would be correct for every row).
  app.route({
    method: 'POST',
    url: '/eval-cases/from-finding',
    schema: { body: FromFindingBody, response: { 200: EvalCase, 201: EvalCase } },
    handler: async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const result = await service.createCaseFromFinding(workspaceId, req.body.finding_id);
      if (!result) throw new NotFoundError('Finding not found');
      reply.status(result.created ? 201 : 200);
      return result.case;
    },
  });

  app.post(
    '/agents/:id/eval-cases',
    { schema: { params: IdParams, body: EvalCaseManualInput, response: { 201: EvalCase } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const created = await service.createManualCase(workspaceId, req.params.id, req.body);
      if (!created) throw new NotFoundError('Agent not found');
      reply.status(201);
      return created;
    },
  );

  app.put(
    '/agents/:id/eval-cases/:caseId',
    { schema: { params: CaseParams, body: EvalCaseManualInput, response: { 200: EvalCase } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const updated = await service.updateCase(
        workspaceId,
        req.params.id,
        req.params.caseId,
        req.body,
      );
      if (!updated) throw new NotFoundError('Eval case not found');
      return updated;
    },
  );

  app.delete(
    '/agents/:id/eval-cases/:caseId',
    { schema: { params: CaseParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const ok = await service.deleteCase(workspaceId, req.params.id, req.params.caseId);
      if (!ok) throw new NotFoundError('Eval case not found');
      reply.status(204);
    },
  );

  // ==== Dashboard (§4.3) ======================================================

  app.get(
    '/eval-dashboard',
    { schema: { response: { 200: EvalDashboardIndex } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getDashboardIndex(workspaceId);
    },
  );

  app.get(
    '/eval-dashboard/:agentId',
    { schema: { params: AgentIdParams, response: { 200: EvalDashboard } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const dashboard = await service.getAgentDashboard(workspaceId, req.params.agentId);
      if (!dashboard) throw new NotFoundError('Agent not found');
      return dashboard;
    },
  );
}
