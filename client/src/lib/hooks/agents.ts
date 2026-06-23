/* hooks/agents.ts — React Query hooks for the A2 Agents tab + Agent Editor. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { Agent, AgentSkillLink, ModelInfo, PRFixtureMeta, Provider, ReviewStrategy, SkillsEvalResult } from "@devdigest/shared";

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<Agent[]>("/agents"),
  });
}

export function useAgent(id: string | null | undefined) {
  return useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.get<Agent>(`/agents/${id}`),
    enabled: !!id,
  });
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  system_prompt: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  enabled?: boolean;
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) => api.post<Agent>("/agents", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export interface UpdateAgentInput {
  id: string;
  patch: Partial<
    Pick<
      Agent,
      | "name"
      | "description"
      | "provider"
      | "model"
      | "system_prompt"
      | "output_schema"
      | "strategy"
      | "ci_fail_on"
      | "repo_intel"
      | "enabled"
    >
  >;
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateAgentInput) => api.put<Agent>(`/agents/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.setQueryData(["agent", data.id], data);
    },
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/agents/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.removeQueries({ queryKey: ["agent", id] });
    },
  });
}

/** Dynamic model list for a provider (editor model picker). */
export function useProviderModels(provider: Provider | null | undefined) {
  return useQuery({
    queryKey: ["provider-models", provider],
    queryFn: () => api.get<ModelInfo[]>(`/providers/${provider}/models`),
    enabled: !!provider,
    staleTime: 5 * 60_000,
  });
}

const keyAgentSkills = (agentId: string) => ["agent-skills", agentId] as const;

export function useAgentSkills(agentId: string | null | undefined) {
  return useQuery({
    queryKey: keyAgentSkills(agentId ?? ""),
    queryFn: () => api.get<AgentSkillLink[]>(`/agents/${agentId}/skills`),
    enabled: !!agentId,
  });
}

/** POST /agents/:id/skills with { skill_ids } — replaces the ordered set. */
export function useSetAgentSkills(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: (input: { skill_ids: string[] }) =>
      api.post<AgentSkillLink[]>(`/agents/${agentId}/skills`, input),
    onMutate: async ({ skill_ids }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        const byId = new Map(prev.map((l) => [l.skill_id, l]));
        const next: AgentSkillLink[] = skill_ids.map((id, i) => {
          const existing = byId.get(id);
          return {
            agent_id: agentId,
            skill_id: id,
            order: i,
            enabled: existing?.enabled ?? true,
          };
        });
        qc.setQueryData<AgentSkillLink[]>(key, next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** POST /agents/:id/skills with { skill_id } — appends a new link. */
export function useLinkAgentSkill(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: (input: { skill_id: string; order?: number; enabled?: boolean }) =>
      api.post<AgentSkillLink[]>(`/agents/${agentId}/skills`, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        const next: AgentSkillLink[] = [
          ...prev,
          {
            agent_id: agentId,
            skill_id: input.skill_id,
            order: input.order ?? prev.length,
            enabled: input.enabled ?? true,
          },
        ];
        qc.setQueryData<AgentSkillLink[]>(key, next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** DELETE /agents/:id/skills/:skillId — unlink a single skill. */
export function useUnlinkAgentSkill(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: (skillId: string) =>
      api.del<AgentSkillLink[]>(`/agents/${agentId}/skills/${skillId}`),
    onMutate: async (skillId) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        const next = prev
          .filter((l) => l.skill_id !== skillId)
          .map((l, i) => ({ ...l, order: i }));
        qc.setQueryData<AgentSkillLink[]>(key, next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** PATCH /agents/:id/skills/:skillId — flip per-link enabled. */
export function useSetAgentSkillEnabled(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: ({ skillId, enabled }: { skillId: string; enabled: boolean }) =>
      api.patch<AgentSkillLink[]>(`/agents/${agentId}/skills/${skillId}`, { enabled }),
    onMutate: async ({ skillId, enabled }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        qc.setQueryData<AgentSkillLink[]>(
          key,
          prev.map((l) => (l.skill_id === skillId ? { ...l, enabled } : l)),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** GET /agents/eval-fixtures — static fixture list (build-time, never stale). */
export function useEvalFixtures() {
  return useQuery<PRFixtureMeta[]>({
    queryKey: ["eval-fixtures"],
    queryFn: () => api.getEvalFixtures(),
    staleTime: Infinity,
  });
}

/** POST /agents/:id/skills-eval — run a skills A/B eval against a fixture. Read-only; no cache invalidation. */
export function useSkillsEval(agentId: string) {
  return useMutation<SkillsEvalResult, Error, { fixture_id: string }>({
    mutationFn: ({ fixture_id }) => api.runSkillsEval(agentId, fixture_id),
  });
}
