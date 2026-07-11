/* BlastTab — layered "changed symbol → callers → endpoints/crons" map, backed
   by GET /pulls/:id/overview/blast-radius (useOverviewBlastRadius). The
   endpoint's `status` can be `degraded` (repo-intel index missing/partial) —
   that must never hide rows that ARE available; it only adds a reason badge.
   When the index isn't built at all (degraded + no rows), this is the FIRST
   consumer of the repo-intel resync hooks (`client/src/lib/hooks/repo-intel.ts`). */
"use client";

import React from "react";
import { Skeleton, ErrorState, EmptyState, Badge, Chip, SectionLabel, MonoLink } from "@devdigest/ui";
import type { ChangedSymbol, DownstreamImpact } from "@devdigest/shared";
import { useOverviewBlastRadius } from "@/lib/hooks/overview";
import { useResyncRepoIntel, useRepoIntelStatus } from "@/lib/hooks/repo-intel";
import { githubBlobUrl } from "@/lib/github-urls";
import { s } from "./styles";

/** Server `DegradedReason` enum → human copy for the reason badge. The server always
    sends a machine reason (e.g. `no_data`), so we must map it — never render it raw. */
const DEGRADED_REASON_COPY: Record<string, string> = {
  no_data: "Repo index isn't built yet — showing best-effort results.",
  index_partial: "Repo index is partial — some callers or endpoints may be missing.",
  index_failed: "Repo indexing failed — showing best-effort results.",
  flag_off: "Repo intelligence is disabled — showing best-effort results.",
  repo_too_large: "Repo is too large to fully index — results are partial.",
};

interface BlastTabProps {
  prId: string | null;
  repoId: string;
  repoFullName: string | null;
  headSha: string | null;
}

function ChangedSymbolBlock({
  symbol,
  downstream,
  repoFullName,
  headSha,
}: {
  symbol: ChangedSymbol;
  downstream: DownstreamImpact | undefined;
  repoFullName: string | null;
  headSha: string | null;
}) {
  const callers = downstream?.callers ?? [];
  const endpoints = downstream?.endpoints_affected ?? [];
  const crons = downstream?.crons_affected ?? [];

  return (
    <div style={s.symbolBlock}>
      <div style={s.symbolHeader}>
        <span style={s.symbolName}>{symbol.name}</span>
        <span style={s.symbolMeta}>
          {symbol.kind} · {symbol.file}
        </span>
      </div>

      {callers.length > 0 ? (
        <ul style={s.callerList}>
          {callers.map((c) => {
            const fileHref =
              repoFullName && headSha ? githubBlobUrl(repoFullName, headSha, c.file, c.line) : undefined;
            return (
              <li key={`${c.file}:${c.line}:${c.name}`} style={s.callerItem}>
                <span style={s.callerName}>{c.name}</span>
                <MonoLink href={fileHref}>
                  {c.file}:{c.line}
                </MonoLink>
              </li>
            );
          })}
        </ul>
      ) : (
        <div style={s.noCallers}>No callers found.</div>
      )}

      {endpoints.length > 0 && (
        <div style={s.chipRow}>
          {endpoints.map((endpoint) => (
            <Chip key={endpoint} icon="Globe">
              {endpoint}
            </Chip>
          ))}
        </div>
      )}

      {crons.length > 0 && (
        <div style={s.chipRow}>
          {crons.map((cron) => (
            <Chip key={cron} icon="Clock">
              {cron}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

export function BlastTab({ prId, repoId, repoFullName, headSha }: BlastTabProps) {
  const { data, isLoading, isError, refetch } = useOverviewBlastRadius(prId);
  const resync = useResyncRepoIntel(repoId);
  // While a user-initiated resync is running, poll the index state so the
  // "index isn't built yet" empty state can clear once the background job
  // finishes. The status enum is terminal-only, so completion is detected by the
  // index identity (lastIndexedSha/updatedAt) advancing past the value captured at
  // resync start — the convention documented in hooks/repo-intel.ts.
  const [isResyncing, setIsResyncing] = React.useState(false);
  const repoIntelStatus = useRepoIntelStatus(repoId, isResyncing);
  const baselineRef = React.useRef<string | null>(null);

  const handleResync = React.useCallback(() => {
    const cur = repoIntelStatus.data;
    baselineRef.current = cur ? `${cur.lastIndexedSha}:${cur.updatedAt}` : null;
    setIsResyncing(true);
    resync.mutate();
  }, [resync, repoIntelStatus.data]);

  // Abort the poll if the resync request itself failed, so the CTA doesn't spin forever.
  React.useEffect(() => {
    if (isResyncing && resync.isError) setIsResyncing(false);
  }, [isResyncing, resync.isError]);

  // Completion: once the index identity advances past the baseline, stop polling AND
  // refetch the blast query — nothing else would (refetchOnWindowFocus is off), so this
  // is what actually clears the empty state after a rebuild.
  React.useEffect(() => {
    if (!isResyncing) return;
    const cur = repoIntelStatus.data;
    if (!cur) return;
    const id = `${cur.lastIndexedSha}:${cur.updatedAt}`;
    if (baselineRef.current === null) {
      baselineRef.current = id;
      return;
    }
    if (id !== baselineRef.current) {
      setIsResyncing(false);
      void refetch();
    }
  }, [isResyncing, repoIntelStatus.data, refetch]);

  if (isLoading) {
    return (
      <section data-testid="blast-loading">
        <SectionLabel icon="Workflow">Blast radius</SectionLabel>
        <Skeleton height={120} />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section>
        <SectionLabel icon="Workflow">Blast radius</SectionLabel>
        <ErrorState title="Couldn't load the blast radius" body="Try again in a moment." />
      </section>
    );
  }

  const { status, reason, data: blast } = data;
  const hasChangedSymbols = blast.changed_symbols.length > 0;

  if (status === "degraded" && !hasChangedSymbols) {
    return (
      <section>
        <SectionLabel icon="Workflow">Blast radius</SectionLabel>
        <EmptyState
          icon="Search"
          title="Repo index isn't built yet"
          body="Build the repo index to see downstream callers, endpoints, and crons affected by this change."
          cta="Resync repo index"
          onCta={handleResync}
          ctaLoading={resync.isPending || isResyncing}
        />
      </section>
    );
  }

  if (status === "ready" && !hasChangedSymbols) {
    return (
      <section>
        <SectionLabel icon="Workflow">Blast radius</SectionLabel>
        <EmptyState
          icon="CheckCircle"
          title="Indexed — no downstream impact detected"
          body="The repo index is up to date and no callers, endpoints, or crons were affected by this change."
        />
      </section>
    );
  }

  return (
    <section>
      <SectionLabel icon="Workflow">Blast radius</SectionLabel>
      {status === "degraded" && (
        <Badge
          icon="AlertTriangle"
          color="var(--warn, #d97706)"
          bg="var(--warn-bg, #3a2a05)"
          style={s.degradedBadge}
        >
          {(reason && DEGRADED_REASON_COPY[reason]) ?? "Partial index — results may be incomplete."}
        </Badge>
      )}
      <div style={s.symbolList}>
        {blast.changed_symbols.map((symbol) => (
          <ChangedSymbolBlock
            key={`${symbol.file}:${symbol.name}`}
            symbol={symbol}
            downstream={blast.downstream.find((d) => d.symbol === symbol.name)}
            repoFullName={repoFullName}
            headSha={headSha}
          />
        ))}
      </div>
    </section>
  );
}
