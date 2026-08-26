/* EvalsTab — agent editor "Evals" tab (L06). Metric tiles for the most
   recent batch, the agent's eval-case set (each case's expectation kind,
   file:line range and last-run result), a run-all action, per-case
   run/edit/delete, the run history and the recall/precision/citation trend.
   Manually created cases (Case Editor) and finding-derived cases share one
   set and run through the same route (contract §4.1/§4.2) — this tab has no
   per-origin branching. */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Skeleton } from "@devdigest/ui";
import type { Agent, EvalCase, EvalRunRecord, EvalTrendPoint } from "@devdigest/shared";
import { useEvalCases, useEvalRuns, useEvalBatch, useRunEvalBatch, useDeleteEvalCase } from "@/lib/hooks/eval";
import { EvalMetricTiles } from "@/components/eval/EvalMetricTiles";
import { EvalRunsTable } from "@/components/eval/EvalRunsTable";
import { EvalTrendChart } from "@/components/eval/EvalTrendChart";
import { EvalCaseRow } from "./_components/EvalCaseRow";
import { EvalCaseModal } from "./_components/EvalCaseModal";
import { s } from "./styles";

/** A batch with a `null` metric is omitted from the trend series rather than
 *  coerced (contract §3.4) — this mirrors what the server would return from
 *  a dedicated trend endpoint, built here from the run history already in
 *  hand instead of a second round trip. */
function toTrend(runs: { ran_at: string; recall: number | null; precision: number | null; citation_accuracy: number | null; traces_passed: number; cases_total: number; cost_usd: number | null }[]): EvalTrendPoint[] {
  return runs
    .filter((r) => r.recall != null && r.precision != null && r.citation_accuracy != null)
    .map((r) => ({
      ran_at: r.ran_at,
      recall: r.recall as number,
      precision: r.precision as number,
      citation_accuracy: r.citation_accuracy as number,
      pass_rate: r.cases_total > 0 ? r.traces_passed / r.cases_total : 0,
      cost_usd: r.cost_usd,
    }))
    .slice()
    .reverse();
}

export function EvalsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("eval");
  const cases = useEvalCases(agent.id);
  const runs = useEvalRuns(agent.id);
  const latestBatch = runs.data?.[0] ?? null;
  const latestBatchDetail = useEvalBatch(agent.id, latestBatch?.id);
  const runBatch = useRunEvalBatch(agent.id);
  const deleteCase = useDeleteEvalCase(agent.id);

  const [modalTarget, setModalTarget] = useState<EvalCase | "new" | null>(null);
  const [runningScope, setRunningScope] = useState<"all" | string | null>(null);

  const lastRunByCaseId = new Map<string, EvalRunRecord>(
    (latestBatchDetail.data?.cases ?? []).map((r) => [r.case_id, r]),
  );
  const trend = toTrend(runs.data ?? []);
  const caseList = cases.data ?? [];

  function runAll() {
    setRunningScope("all");
    runBatch.mutate(undefined, { onSettled: () => setRunningScope(null) });
  }

  function runOne(caseId: string) {
    setRunningScope(caseId);
    runBatch.mutate([caseId], { onSettled: () => setRunningScope(null) });
  }

  const modalEvalCase = modalTarget === "new" || modalTarget === null ? null : modalTarget;
  const modalLastRun = modalEvalCase ? lastRunByCaseId.get(modalEvalCase.id) ?? null : null;

  return (
    <div style={s.wrap}>
      <div>
        <div style={s.metricsHeader}>
          <div>
            <h2 style={s.title}>{t("evalsTab.metricsTitle")}</h2>
            <p style={s.subtitle}>{t("evalsTab.metricsSubtitle")}</p>
          </div>
          <Link href={`/eval-dashboard/${agent.id}`} style={s.dashboardLink}>
            {t("evalsTab.viewDashboard")}
          </Link>
        </div>
        <EvalMetricTiles
          recall={latestBatch?.recall ?? null}
          precision={latestBatch?.precision ?? null}
          citationAccuracy={latestBatch?.citation_accuracy ?? null}
          tracesPassed={latestBatch?.traces_passed ?? 0}
          tracesTotal={latestBatch?.cases_total ?? 0}
        />
      </div>

      <div>
        <div style={s.sectionHeader}>
          <h3 style={s.sectionTitle}>{t("evalsTab.casesHeading")}</h3>
          <Button
            kind="secondary"
            size="sm"
            icon="Play"
            disabled={caseList.length === 0 || runningScope === "all"}
            onClick={runAll}
          >
            {runningScope === "all" ? t("evalsTab.runningAll") : t("evalsTab.runAll")}
          </Button>
          <Button kind="primary" size="sm" icon="Plus" onClick={() => setModalTarget("new")}>
            {t("evalsTab.newCase")}
          </Button>
        </div>

        {cases.isLoading ? (
          <div style={s.loading}>
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        ) : cases.isError ? (
          <ErrorState onRetry={() => cases.refetch()} />
        ) : caseList.length === 0 ? (
          <div style={s.empty}>{t("evalsTab.emptyCases")}</div>
        ) : (
          <div style={s.list}>
            {caseList.map((c) => (
              <EvalCaseRow
                key={c.id}
                evalCase={c}
                lastRun={lastRunByCaseId.get(c.id)}
                isRunning={runningScope === c.id}
                onRun={() => runOne(c.id)}
                onEdit={() => setModalTarget(c)}
                onDelete={() => deleteCase.mutate(c.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 style={s.sectionTitle}>{t("dashboard.recentRuns")}</h3>
        <EvalRunsTable runs={runs.data ?? []} />
      </div>

      <div>
        <h3 style={s.sectionTitle}>{t("dashboard.metricTrend")}</h3>
        {/* `toTrend` drops any batch missing one of the three metrics, so an
            agent whose runs all produced zero findings yields an empty series
            while the runs table right above lists them. The chart's own empty
            state says "no runs yet", which is then simply false — distinguish
            "nothing ran" from "nothing plottable" before handing off. */}
        {trend.length === 0 && (runs.data?.length ?? 0) > 0 ? (
          <div style={s.trendUnplottable}>{t("evalsTab.noPlottableMetrics")}</div>
        ) : (
          <EvalTrendChart trend={trend} />
        )}
      </div>

      {modalTarget !== null && (
        <EvalCaseModal
          agentId={agent.id}
          evalCase={modalEvalCase}
          lastRun={modalLastRun}
          onClose={() => setModalTarget(null)}
        />
      )}
    </div>
  );
}
