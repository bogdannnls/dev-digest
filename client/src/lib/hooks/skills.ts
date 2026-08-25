/* hooks/skills.ts — TanStack Query hooks for the Skills inventory.
   Owns server state for /skills, /skills/:id, /skills/:id/usage.
   Components consume these — no `api.*` calls live in views. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillSource, SkillType } from "@devdigest/shared";
import { api } from "../api";

const KEY_LIST = ["skills"] as const;
const keyOne = (id: string | null | undefined) => ["skill", id] as const;
const keyUsage = (id: string) => ["skill-usage", id] as const;

export function useSkills() {
  return useQuery({
    queryKey: KEY_LIST,
    queryFn: () => api.get<Skill[]>("/skills"),
  });
}

export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: keyOne(id),
    queryFn: () => api.get<Skill>(`/skills/${id}`),
    enabled: !!id,
  });
}

export function useSkillUsage(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? keyUsage(id) : ["skill-usage", null],
    queryFn: () => api.get<{ agent_count: number }>(`/skills/${id}/usage`),
    enabled: !!id,
  });
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>("/skills", input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: KEY_LIST });
      qc.setQueryData(keyOne(data.id), data);
    },
  });
}

export interface UpdateSkillInput {
  id: string;
  patch: Partial<
    Pick<Skill, "name" | "description" | "type" | "body" | "enabled" | "attached_context_paths">
  >;
  /** Transient — the workspace's currently-active repo selection. The server
   *  REQUIRES this whenever `patch.attached_context_paths` is present (T3's
   *  `.refine()`, AC-12c's "governing repo"); it validates each submitted path
   *  against that repo's freshly-discovered set and is never persisted or
   *  merged into the cached `Skill`. */
  repo_id?: string;
}

/** PUT /skills/:id with optimistic patch into the cached list + detail. */
export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, repo_id }: UpdateSkillInput) =>
      api.put<Skill>(`/skills/${id}`, repo_id !== undefined ? { ...patch, repo_id } : patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: KEY_LIST });
      const prevList = qc.getQueryData<Skill[]>(KEY_LIST);
      const prevOne = qc.getQueryData<Skill>(keyOne(id));
      if (prevList) {
        qc.setQueryData<Skill[]>(
          KEY_LIST,
          prevList.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        );
      }
      if (prevOne) {
        qc.setQueryData<Skill>(keyOne(id), { ...prevOne, ...patch });
      }
      return { prevList, prevOne };
    },
    onError: (_err, { id }, ctx) => {
      if (ctx?.prevList) qc.setQueryData(KEY_LIST, ctx.prevList);
      if (ctx?.prevOne) qc.setQueryData(keyOne(id), ctx.prevOne);
    },
    onSuccess: (data) => {
      qc.setQueryData(keyOne(data.id), data);
      qc.invalidateQueries({ queryKey: KEY_LIST });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/skills/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: KEY_LIST });
      qc.removeQueries({ queryKey: keyOne(id) });
      qc.removeQueries({ queryKey: keyUsage(id) });
    },
  });
}

export interface ParsedImportPayload {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  warnings: string[];
}

export function useImportSkillPreview() {
  return useMutation({
    mutationFn: (file: File) =>
      api.upload<ParsedImportPayload>("/skills/import/preview", file),
  });
}
