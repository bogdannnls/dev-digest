/* RecentRunsTable — cross-agent feed of the most recent eval batches. Unlike
   the shared `EvalRunsTable` (which is per-agent and carries compare-selection
   checkboxes), this table names the owning agent on every row and has no
   selection — the compare route is scoped to one agent. Page-private to the
   Eval Dashboard landing view. */
"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import type { EvalDashboardIndex } from "@devdigest/shared";
import { formatCost, formatPercent, formatTimestamp } from "@/components/eval/format";
import { s } from "./styles";

type RecentRun = EvalDashboardIndex["recent_runs"][number];

const STATUS_COLOR: Record<RecentRun["status"], string> = {
  running: "var(--warn)",
  succeeded: "var(--ok)",
  failed: "var(--crit)",
};

export interface RecentRunsTableProps {
  runs: RecentRun[];
}

export function RecentRunsTable({ runs }: RecentRunsTableProps) {
  const t = useTranslations("eval.dashboard");

  return (
    <div role="table" style={s.table}>
      <div role="row" style={s.headerRow}>
        <span role="columnheader" style={s.cell} aria-hidden="true" />
        <span role="columnheader" style={s.cell}>
          {t("table.ranAt")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("table.recall")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("table.precision")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("table.citation")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("table.pass")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("table.cost")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("status.label")}
        </span>
      </div>
      {runs.map((run) => (
        <div role="row" style={s.row} key={run.id}>
          <span role="cell" style={s.cell}>
            <span style={s.agentName}>{run.agent_name}</span>
          </span>
          <span role="cell" style={s.cell}>
            {formatTimestamp(run.ran_at)}
          </span>
          <span role="cell" style={s.cell}>
            {formatPercent(run.recall)}
          </span>
          <span role="cell" style={s.cell}>
            {formatPercent(run.precision)}
          </span>
          <span role="cell" style={s.cell}>
            {formatPercent(run.citation_accuracy)}
          </span>
          <span role="cell" style={s.cell}>
            {run.traces_passed}/{run.cases_total}
          </span>
          <span role="cell" style={s.cell}>
            {formatCost(run.cost_usd)}
          </span>
          <span role="cell" style={s.cell}>
            <Badge color={STATUS_COLOR[run.status]}>{t(`status.${run.status}`)}</Badge>
          </span>
        </div>
      ))}
      {runs.length === 0 && <div style={s.empty}>{t("noRuns")}</div>}
    </div>
  );
}
