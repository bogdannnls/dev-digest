/* hooks/eval.ts — React Query hooks for the Eval Pipeline (L06).
   Query keys are fixed by the frozen contract (section 5.1) — do not rename. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { EvalCaseManualInput } from "@devdigest/shared";

const keyEvalCases = (agentId: string) => ["eval-cases", agentId] as const;
const keyEvalRuns = (agentId: string) => ["eval-runs", agentId] as const;
const keyEvalBatch = (batchId: string) => ["eval-batch", batchId] as const;
const keyEvalCompare = (agentId: string, a: string, b: string) =>
  ["eval-compare", agentId, a, b] as const;
const keyEvalDashboardIndex = () => ["eval-dashboard"] as const;
const keyEvalDashboard = (agentId: string) => ["eval-dashboard", agentId] as const;

/** GET /agents/:id/eval-cases — the agent's gold-set cases, ordered by name. */
export function useEvalCases(agentId: string | null | undefined) {
  return useQuery({
    queryKey: keyEvalCases(agentId ?? ""),
    queryFn: () => api.getEvalCases(agentId!),
    enabled: !!agentId,
  });
}

/** POST /eval-cases/from-finding — derives a case from a finding's
 *  accept/dismiss decision. Idempotent server-side per source_finding_id.
 *  Not agent-scoped (v1.4): the server derives the owning agent from
 *  finding -> review.agent_id, so this hook has no agentId to key off up
 *  front — it invalidates precisely that agent's case list using the
 *  `owner_id` on the returned `EvalCase`. */
export function useCreateEvalCaseFromFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) => api.createEvalCaseFromFinding(findingId),
    onSuccess: (evalCase) => qc.invalidateQueries({ queryKey: keyEvalCases(evalCase.owner_id) }),
  });
}

/** POST /agents/:id/eval-cases — hand-written case (Case Editor). */
export function useCreateEvalCase(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EvalCaseManualInput) => api.createEvalCase(agentId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyEvalCases(agentId) }),
  });
}

export interface UpdateEvalCaseInput {
  caseId: string;
  input: EvalCaseManualInput;
}

/** PUT /agents/:id/eval-cases/:caseId */
export function useUpdateEvalCase(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, input }: UpdateEvalCaseInput) => api.updateEvalCase(agentId, caseId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyEvalCases(agentId) }),
  });
}

/** DELETE /agents/:id/eval-cases/:caseId */
export function useDeleteEvalCase(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) => api.deleteEvalCase(agentId, caseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyEvalCases(agentId) }),
  });
}

/** GET /agents/:id/eval-runs — newest-first batch list. */
export function useEvalRuns(agentId: string | null | undefined) {
  return useQuery({
    queryKey: keyEvalRuns(agentId ?? ""),
    queryFn: () => api.getEvalRuns(agentId!),
    enabled: !!agentId,
  });
}

/** GET /agents/:id/eval-runs/:batchId — one batch's system prompt + per-case runs. */
export function useEvalBatch(agentId: string | null | undefined, batchId: string | null | undefined) {
  return useQuery({
    queryKey: keyEvalBatch(batchId ?? ""),
    queryFn: () => api.getEvalBatch(agentId!, batchId!),
    enabled: !!agentId && !!batchId,
  });
}

/** GET /agents/:id/eval-runs/compare?a=&b= — metric deltas + both system prompts. */
export function useCompareEvalRuns(
  agentId: string | null | undefined,
  a: string | null | undefined,
  b: string | null | undefined,
) {
  return useQuery({
    queryKey: keyEvalCompare(agentId ?? "", a ?? "", b ?? ""),
    queryFn: () => api.compareEvalRuns(agentId!, a!, b!),
    enabled: !!agentId && !!a && !!b,
  });
}

/** POST /agents/:id/eval-runs — run every case, or exactly `caseIds` when given,
 *  as one batch. A single-case run is a batch of one; there is no separate route.
 *  A completed run invalidates both the runs list and the dashboard (index +
 *  this agent's aggregate). */
export function useRunEvalBatch(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseIds?: string[]) => api.runEvalBatch(agentId, caseIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keyEvalRuns(agentId) });
      qc.invalidateQueries({ queryKey: keyEvalDashboardIndex() });
      qc.invalidateQueries({ queryKey: keyEvalDashboard(agentId) });
    },
  });
}

/** GET /eval-dashboard — cross-agent landing view. */
export function useEvalDashboardIndex() {
  return useQuery({
    queryKey: keyEvalDashboardIndex(),
    queryFn: () => api.getEvalDashboardIndex(),
  });
}

/** GET /eval-dashboard/:agentId — one agent's aggregate metrics. */
export function useEvalDashboard(agentId: string | null | undefined) {
  return useQuery({
    queryKey: keyEvalDashboard(agentId ?? ""),
    queryFn: () => api.getEvalDashboard(agentId!),
    enabled: !!agentId,
  });
}
