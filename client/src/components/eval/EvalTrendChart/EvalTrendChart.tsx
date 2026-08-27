/* EvalTrendChart — recall / precision / citation accuracy across an agent's
   runs, on top of the shared LineChart. `EvalTrendPoint` requires non-null
   numbers, so a batch with a `null` metric is omitted from the trend series
   (contract 3.4) — this component must tolerate a shorter series than the
   runs table, including empty. Shared by the Evals tab and the Eval
   Dashboard (ui-architecture MUST.4 forbids cross-page imports). */
"use client";

import { useTranslations } from "next-intl";
import { LineChart } from "@devdigest/ui";
import type { EvalTrendPoint } from "@devdigest/shared";
import { s } from "./styles";

export interface EvalTrendChartProps {
  trend: EvalTrendPoint[];
}

export function EvalTrendChart({ trend }: EvalTrendChartProps) {
  const t = useTranslations("eval.dashboard");

  if (trend.length === 0) {
    return <div style={s.empty}>{t("noRuns")}</div>;
  }

  const series = [
    { name: t("legend.recall"), color: "var(--accent)", data: trend.map((p) => p.recall) },
    { name: t("legend.precision"), color: "var(--ok)", data: trend.map((p) => p.precision) },
    { name: t("legend.citation"), color: "var(--warn)", data: trend.map((p) => p.citation_accuracy) },
  ];

  return (
    <div style={s.wrap}>
      <LineChart series={series} />
      <div style={s.legend}>
        {series.map((sr) => (
          <span key={sr.name} style={s.legendItem}>
            <span style={{ ...s.dot, background: sr.color }} />
            {sr.name}
          </span>
        ))}
      </div>
    </div>
  );
}
