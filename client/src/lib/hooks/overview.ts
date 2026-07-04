/* hooks/overview.ts — PR Overview tab queries.
   Slice A: PR Brief (verdict / score / cost).
   Intent Layer (P1): IntentCard — read-through cached goal/scope/risk extraction,
   see docs/superpowers/specs/2026-07-04-intent-layer-design.md §13.2. */
"use client";

import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE, ApiError } from "../api";
import type {
  PrIntentDto,
  PrIntentResponse,
  PrIntentStaleReason,
  PrOverviewBriefResponse,
} from "@devdigest/shared";

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

const overviewIntentKey = (prId: string | null | undefined) => ["overview-intent", prId] as const;

export interface UseOverviewIntent {
  status: "idle" | "loading" | "ready" | "ready-stale" | "computing" | "error";
  data: PrIntentDto | null;
  staleReasons: PrIntentStaleReason[] | null;
  error: string | null;
  progress: string | null;
  /**
   * True while an explicit user-initiated `refresh()` is in flight (server
   * accepted the POST, background job is running, SSE `done` not yet
   * received). Cache-miss auto-compute is signalled via `status: "computing"`
   * instead — this flag distinguishes user intent from first-time compute
   * so the card can keep showing prior data while the recompute streams in.
   */
  isRefreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * IntentCard's data source. Wraps `GET /pulls/:id/overview/intent`
 * (4-state discriminated response) and, while the cached row is `computing`,
 * opens an SSE subscription to stream extraction progress — mirrors the
 * `useExtractConventions` pattern (independent React state driving the
 * EventSource, not tied into the query's own fetch lifecycle).
 */
export function useOverviewIntent(prId: string | null | undefined): UseOverviewIntent {
  const qc = useQueryClient();
  const [progress, setProgress] = React.useState<string | null>(null);
  // runId captured from an explicit `refresh()` POST — orthogonal to the
  // server-side `computing` runId (which is set on first-view cold compute).
  // See spec §13 + interface docs on `isRefreshing`.
  const [refreshRunId, setRefreshRunId] = React.useState<string | null>(null);

  const query = useQuery<PrIntentResponse>({
    queryKey: overviewIntentKey(prId),
    queryFn: () => api.get<PrIntentResponse>(`/pulls/${prId}/overview/intent`),
    enabled: !!prId,
  });

  const serverComputingRunId =
    query.data?.status === "computing" ? query.data.runId : null;
  // Prefer the user-initiated refresh's runId; otherwise use the server's
  // first-view cold-compute runId. Only one is ever active at a time in
  // practice (a refresh replaces any prior compute for this PR).
  const activeRunId = refreshRunId ?? serverComputingRunId;

  React.useEffect(() => {
    if (!activeRunId) {
      setProgress(null);
      return;
    }

    const es = new EventSource(
      `${API_BASE}/pulls/${prId}/overview/intent/stream?runId=${activeRunId}`,
    );

    const onInfo = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { msg?: string };
        if (data.msg) setProgress(data.msg);
      } catch {
        /* ignore non-JSON keepalive frames */
      }
    };
    const onDone = () => {
      es.close();
      setRefreshRunId(null);
      qc.invalidateQueries({ queryKey: overviewIntentKey(prId) });
    };
    const onError = () => {
      es.close();
      // Do NOT clear refreshRunId here — the query will re-fetch and either
      // return the stale row (if the job errored before writing) or a fresh
      // ready row (if the job completed but the SSE bridge dropped).
    };

    es.addEventListener("info", onInfo as EventListener);
    es.addEventListener("done", onDone);
    es.addEventListener("error", onError as EventListener);
    es.onerror = onError;

    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, prId]);

  const refresh = React.useCallback(async () => {
    if (!prId) return;
    try {
      const { runId } = await api.post<{ runId: string }>(
        `/pulls/${prId}/overview/intent/refresh`,
      );
      // Drive the "computing" UI locally until the job's SSE 'done' fires —
      // don't rely on query invalidation alone, because the row is still fresh
      // until upsert lands and GET would return the pre-refresh 'ready' row.
      setRefreshRunId(runId);
      setProgress("Refreshing…");
    } catch (e) {
      // Surface 429 (rate-limited) as a distinguishable error the component
      // renders as a toast, per spec §13.6 — re-throw so the caller can
      // branch on `ApiError.status` instead of parsing message text.
      if (e instanceof ApiError) throw e;
      throw new ApiError(e instanceof Error ? e.message : "Refresh failed", 0);
    }
  }, [prId]);

  const isRefreshing = refreshRunId !== null;

  if (!prId) {
    return { status: "idle", data: null, staleReasons: null, error: null, progress: null, isRefreshing: false, refresh };
  }
  if (query.isPending) {
    return { status: "loading", data: null, staleReasons: null, error: null, progress: null, isRefreshing, refresh };
  }
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : "Failed to load intent";
    return { status: "error", data: null, staleReasons: null, error: message, progress: null, isRefreshing, refresh };
  }

  const result = query.data;
  switch (result.status) {
    case "ready":
      return { status: "ready", data: result.data, staleReasons: null, error: null, progress: isRefreshing ? progress : null, isRefreshing, refresh };
    case "ready-stale":
      return {
        status: "ready-stale",
        data: result.data,
        staleReasons: result.staleReasons,
        error: null,
        progress: isRefreshing ? progress : null,
        isRefreshing,
        refresh,
      };
    case "computing":
      return { status: "computing", data: null, staleReasons: null, error: null, progress, isRefreshing, refresh };
    case "error":
      return { status: "error", data: null, staleReasons: null, error: result.message, progress: null, isRefreshing, refresh };
  }
}
