/* hooks/overview.ts — PR Overview tab queries.
   Slice A: PR Brief only (verdict / score / cost). */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { PrOverviewBriefResponse } from "@devdigest/shared";

/**
 * Synchronous brief aggregation. Cheap (one query per PR), so refetch on
 * mount is fine; staleTime keeps the card stable while the user clicks
 * around tabs without thrashing the network.
 */
export function useOverviewBrief(prId: string | null | undefined) {
  return useQuery<PrOverviewBriefResponse>({
    queryKey: ["overview-brief", prId],
    queryFn: () => api.get<PrOverviewBriefResponse>(`/pulls/${prId}/overview/brief`),
    enabled: !!prId,
    staleTime: 30_000,
  });
}
