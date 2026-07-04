/* hooks/smart-diff.ts — synchronous read of the Smart Diff (grouped diff +
   split suggestion) for a PR. Plain TanStack Query hook, same shape as
   usePrComments — no SSE, no custom transforms. `DiffTab` handles graceful
   degradation on error/loading. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SmartDiff } from "@devdigest/shared";

/** Smart Diff for a PR — file groups (core/wiring/boilerplate) plus a
   too-big/split suggestion. */
export function useSmartDiff(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["smart-diff", prId],
    queryFn: () => api.get<SmartDiff>(`/pulls/${prId}/smart-diff`),
    enabled: !!prId,
  });
}
