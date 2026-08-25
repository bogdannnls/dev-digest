/* EvalDashboardView — the Eval Dashboard's landing view: every agent as a row
   with its model, case count, last-run metrics and a sparkline, plus a
   cross-agent "recent runs" feed. Selecting an agent opens its detail view at
   /eval-dashboard/:agentId. */
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { useEvalDashboardIndex } from "@/lib/hooks";
import { AgentsSummaryTable } from "./_components/AgentsSummaryTable/AgentsSummaryTable";
import { RecentRunsTable } from "./_components/RecentRunsTable/RecentRunsTable";
import { s } from "./styles";

export function EvalDashboardView() {
  const t = useTranslations("eval");
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useEvalDashboardIndex();

  const crumb = [{ label: t("page.crumbSkillsLab") }, { label: t("page.crumbEvalDashboard") }];

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.h1}>{t("index.title")}</h1>
          <p style={s.subtitle}>{t("index.subtitle")}</p>
        </div>

        {isLoading && (
          <div style={s.loadingStack}>
            <Skeleton height={140} />
            <Skeleton height={200} />
          </div>
        )}

        {isError && (
          <ErrorState body={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
        )}

        {!isLoading && !isError && data && (
          <>
            <section style={s.section}>
              <h2 style={s.h2}>{t("index.agentsHeading")}</h2>
              {data.agents.length === 0 ? (
                <EmptyState icon="Target" title={t("dashboard.noRuns")} />
              ) : (
                <AgentsSummaryTable
                  agents={data.agents}
                  onSelect={(agentId) => router.push(`/eval-dashboard/${agentId}`)}
                />
              )}
            </section>

            <section style={s.section}>
              <h2 style={s.h2}>{t("index.recentRunsHeading")}</h2>
              <RecentRunsTable runs={data.recent_runs} />
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
