/* hooks/conventions.ts — TanStack Query hooks for the Conventions API.
   Owns server state for /repos/:id/conventions and the extraction SSE stream.
   Components consume these — no raw fetch calls live in views. */
"use client";

import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConventionCandidate, ConventionListResponse, Skill } from '@devdigest/shared';
import { apiFetch, API_BASE } from '../api.js';

const keyList = (repoId: string) => ['conventions', repoId] as const;

export function useConventions(repoId: string | null) {
  return useQuery({
    queryKey: repoId ? keyList(repoId) : ['conventions', '__none__'],
    queryFn: () => apiFetch<ConventionListResponse>(`/repos/${repoId}/conventions`),
    enabled: repoId !== null,
  });
}

export function useUpdateConvention(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { accepted?: boolean; rule?: string } }) =>
      apiFetch<ConventionCandidate>(`/conventions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyList(repoId) }),
  });
}

export function useCreateSkillsFromConventions(repoId: string) {
  return useMutation({
    mutationFn: (opts?: { agent_id?: string }) =>
      apiFetch<{ skills: Skill[] }>(`/repos/${repoId}/conventions/to-skills`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }),
  });
}

export interface ExtractionState {
  extracting: boolean;
  progress: string | null;
}

export function useExtractConventions(repoId: string) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<ExtractionState>({
    extracting: false,
    progress: null,
  });

  const extract = React.useCallback(async () => {
    setState({ extracting: true, progress: 'Starting...' });
    try {
      const { scan_id } = await apiFetch<{ scan_id: string }>(
        `/repos/${repoId}/conventions/extract`,
        { method: 'POST', body: JSON.stringify({}) },
      );

      await new Promise<void>((resolve, reject) => {
        const es = new EventSource(
          `${API_BASE}/repos/${repoId}/conventions/events/${scan_id}`,
        );

        const handle = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(ev.data) as { msg?: string };
            setState((s) => ({ ...s, progress: data.msg ?? s.progress }));
          } catch { /* ignore */ }
        };

        for (const kind of ['sampling', 'analyzing', 'verifying']) {
          es.addEventListener(kind, handle as EventListener);
        }
        es.addEventListener('done', () => {
          es.close();
          resolve();
        });
        es.addEventListener('error', (ev: Event) => {
          es.close();
          try {
            const data = JSON.parse((ev as MessageEvent).data) as { msg?: string };
            reject(new Error(data.msg ?? 'Extraction failed'));
          } catch {
            reject(new Error('Extraction failed'));
          }
        });
        es.onerror = () => { es.close(); reject(new Error('SSE connection error')); };
      });

      await qc.invalidateQueries({ queryKey: keyList(repoId) });
    } finally {
      setState({ extracting: false, progress: null });
    }
  }, [repoId, qc]);

  return { extract, ...state };
}
