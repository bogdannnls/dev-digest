/* BlastRadiusCard — Overview-tab card showing the "changed symbol → callers →
   endpoints/crons" impact map, backed by GET /pulls/:id/overview/blast-radius
   (useOverviewBlastRadius). Re-homed from the standalone Blast tab into the
   Overview tab per docs/superpowers/specs/2026-06-24-pr-overview-tab-design.md
   §5.3/§7 — sits next to IntentCard. The endpoint's `status` can be `degraded`
   (repo-intel index missing/partial) — that must never hide rows that ARE
   available; it only adds a reason badge above the tree. When the index isn't
   built at all (degraded + no rows), this is a consumer of the repo-intel
   resync hooks (`client/src/lib/hooks/repo-intel.ts`). */
"use client";

import React from "react";
import { Icon, Skeleton, ErrorState, EmptyState, Badge, Chip, SectionLabel, MonoLink } from "@devdigest/ui";
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

/** `3 callers`, `1 caller`, `0 crons` — regular English plural. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface BlastRadiusCardProps {
  prId: string | null;
  repoId: string;
  repoFullName: string | null;
  headSha: string | null;
}

/** Tree | Graph segmented control. Graph mode is v2 (spec §7) — rendered
    disabled with a tooltip until the graph view ships; Tree is the only
    view that ever renders. */
function ViewToggle() {
  const [view] = React.useState<"tree" | "graph">("tree");
  return (
    <div style={s.viewToggle} role="group" aria-label="Blast radius view">
      <button type="button" style={s.viewToggleBtn(view === "tree")} aria-pressed={view === "tree"}>
        Tree
      </button>
      <button
        type="button"
        style={s.viewToggleBtn(false)}
        disabled
        aria-pressed={false}
        title="Graph view — v2"
      >
        Graph
      </button>
    </div>
  );
}

function SymbolNode({
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
  // Expand by default when the symbol has ANY downstream signal — a framework-invoked
  // route handler can have 0 static callers but still carry the highest-value data
  // (affected endpoints/crons), which must not be hidden behind a "0 callers" header.
  const [expanded, setExpanded] = React.useState(
    callers.length > 0 || endpoints.length > 0 || crons.length > 0,
  );
  const Chevron = expanded ? Icon.ChevronDown : Icon.ChevronRight;

  return (
    <div style={s.symbolNode}>
      <button
        type="button"
        style={s.symbolNodeHeader}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <Chevron size={14} style={s.chevron} />
        <Icon.Code size={14} style={s.codeIcon} />
        <span style={s.symbolName}>{symbol.name}</span>
        <span style={s.symbolMeta}>
          {symbol.kind} · {symbol.file}
        </span>
        <span style={s.callerBadge}>{plural(callers.length, "caller")}</span>
      </button>

      {expanded && (
        <div style={s.symbolBody}>
          {callers.length > 0 ? (
            <ul style={s.callerList}>
              {callers.map((c) => {
                const fileHref =
                  repoFullName && headSha ? githubBlobUrl(repoFullName, headSha, c.file, c.line) : undefined;
                return (
                  <li key={`${c.file}:${c.line}:${c.name}`} style={s.callerItem}>
                    <span style={s.callerConnector}>↳</span>
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
      )}
    </div>
  );
}

export function BlastRadiusCard({ prId, repoId, repoFullName, headSha }: BlastRadiusCardProps) {
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

  const counts = React.useMemo(() => {
    const blast = data?.data;
    if (!blast) return { symbols: 0, callers: 0, endpoints: 0, crons: 0 };
    const endpointSet = new Set<string>();
    const cronSet = new Set<string>();
    let callers = 0;
    for (const d of blast.downstream) {
      callers += d.callers.length;
      for (const e of d.endpoints_affected) endpointSet.add(e);
      for (const c of d.crons_affected) cronSet.add(c);
    }
    return {
      symbols: blast.changed_symbols.length,
      callers,
      endpoints: endpointSet.size,
      crons: cronSet.size,
    };
  }, [data]);

  if (isLoading) {
    return (
      <section data-testid="blast-radius-loading">
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
      <div style={s.card}>
        <div style={s.countsRow}>
          <span style={s.counts} data-testid="blast-counts">
            {plural(counts.symbols, "symbol")} · {plural(counts.callers, "caller")} ·{" "}
            {plural(counts.endpoints, "endpoint")} · {plural(counts.crons, "cron")}
          </span>
          <ViewToggle />
        </div>

        {status === "degraded" && (
          <Badge icon="AlertTriangle" color="var(--warn, #d97706)" bg="var(--warn-bg, #3a2a05)">
            {(reason && DEGRADED_REASON_COPY[reason]) ?? "Partial index — results may be incomplete."}
          </Badge>
        )}

        <div style={s.symbolList}>
          {blast.changed_symbols.map((symbol) => (
            <SymbolNode
              key={`${symbol.file}:${symbol.name}`}
              symbol={symbol}
              downstream={blast.downstream.find((d) => d.symbol === symbol.name)}
              repoFullName={repoFullName}
              headSha={headSha}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
