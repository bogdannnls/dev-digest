/* EvalAgentDashboardView — per-agent eval detail: header (name + model),
   metric tiles, an alert banner when the dashboard reports a regression, the
   metric trend chart, and the run-history table where ticking two runs opens
   the comparison modal. Every render piece here is shared with the Evals tab
   via `@/components/eval/**` (ui-architecture MUST.4 forbids cross-page
   imports, so nothing is imported from `app/agents/**`). */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AppShell } from "@/components/app-shell";
import { Badge, Button, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { useAgent } from "@/lib/hooks/agents";
import { useCompareEvalRuns, useEvalDashboard, useEvalRuns, useRunEvalBatch } from "@/lib/hooks";
import { EvalMetricTiles } from "@/components/eval/EvalMetricTiles";
import { EvalTrendChart } from "@/components/eval/EvalTrendChart";
import { EvalRunsTable } from "@/components/eval/EvalRunsTable";
import { EvalRunComparison } from "@/components/eval/EvalRunComparison";
import { s } from "./styles";

export interface EvalAgentDashboardViewProps {
  agentId: string;
}

export function EvalAgentDashboardView({ agentId }: EvalAgentDashboardViewProps) {
  const t = useTranslations("eval");
  const router = useRouter();
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);

  const { data: agent, isLoading: agentLoading, isError: agentIsError } = useAgent(agentId);
  const {
    data: dashboard,
    isLoading: dashboardLoading,
    isError: dashboardIsError,
    error: dashboardError,
    refetch: refetchDashboard,
  } = useEvalDashboard(agentId);
  const { data: runs, isLoading: runsLoading } = useEvalRuns(agentId);
  const { data: comparison } = useCompareEvalRuns(agentId, compareIds?.[0], compareIds?.[1]);
  const runBatch = useRunEvalBatch(agentId);

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard"), href: "/eval-dashboard" },
    ...(agent ? [{ label: agent.name }] : []),
  ];

  const isLoading = agentLoading || dashboardLoading;
  const isError = agentIsError || dashboardIsError;

  if (isError) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          body={dashboardError instanceof Error ? dashboardError.message : undefined}
          onRetry={() => refetchDashboard()}
        />
      </AppShell>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        {isLoading || !agent || !dashboard ? (
          <div style={s.loadingStack}>
            <Skeleton height={32} width={280} />
            <Skeleton height={140} />
            <Skeleton height={200} />
          </div>
        ) : (
          <>
            <div style={s.header}>
              <Icon.Cpu size={18} style={s.headerIcon} />
              <h1 style={s.h1}>{agent.name}</h1>
              <Badge color="var(--text-secondary)" mono>
                {agent.model}
              </Badge>
              <div style={s.headerActions}>
                <Button kind="ghost" size="sm" onClick={() => router.push(`/agents/${agentId}?tab=evals`)}>
                  {t("dashboard.configure")}
                </Button>
                <Button
                  kind="primary"
                  size="sm"
                  icon="Play"
                  loading={runBatch.isPending}
                  disabled={dashboard.cases_total === 0}
                  onClick={() => runBatch.mutate(undefined)}
                >
                  {runBatch.isPending
                    ? t("dashboard.running")
                    : t("dashboard.runEval", { count: dashboard.cases_total })}
                </Button>
              </div>
            </div>

            {dashboard.alert && (
              <div role="alert" style={s.alertBanner}>
                <Icon.AlertTriangle size={16} />
                <span>{dashboard.alert}</span>
              </div>
            )}

            <div style={s.section}>
              <EvalMetricTiles
                recall={dashboard.current.recall}
                precision={dashboard.current.precision}
                citationAccuracy={dashboard.current.citation_accuracy}
                tracesPassed={dashboard.current.traces_passed}
                tracesTotal={dashboard.current.traces_total}
                delta={{
                  recall: dashboard.delta.recall,
                  precision: dashboard.delta.precision,
                  citationAccuracy: dashboard.delta.citation_accuracy,
                }}
              />
            </div>

            <section style={s.section}>
              <h2 style={s.h2}>{t("dashboard.metricTrend")}</h2>
              <EvalTrendChart trend={dashboard.trend} />
            </section>

            <section style={s.section}>
              <h2 style={s.h2}>{t("dashboard.recentRuns")}</h2>
              {runsLoading ? (
                <Skeleton height={160} />
              ) : (
                <EvalRunsTable runs={runs ?? []} onCompare={(a, b) => setCompareIds([a, b])} />
              )}
            </section>
          </>
        )}
      </div>

      {compareIds && comparison && (
        <EvalRunComparison comparison={comparison} onClose={() => setCompareIds(null)} />
      )}
    </AppShell>
  );
}
