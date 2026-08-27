/* EvalMetricTiles — recall / precision / citation accuracy / traces passed.
   Shared by the Evals tab (per-agent) and the Eval Dashboard (per-agent and
   cross-agent) — cross-page imports are forbidden, so this lives in
   `components/eval/` rather than under either page (ui-architecture MUST.4). */
"use client";

import { useTranslations } from "next-intl";
import { MetricCard } from "@devdigest/ui";
import { formatPercent } from "../format";
import { s } from "./styles";

export interface EvalMetricDeltas {
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
}

export interface EvalMetricTilesProps {
  /** Fraction 0..1, or `null` when the denominator was empty (contract 3.4) —
   *  rendered as an em dash, never coerced to 0%. */
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  tracesPassed: number;
  tracesTotal: number;
  /** Optional deltas vs. the previous run, shown on each tile when present. */
  delta?: EvalMetricDeltas | null;
}

export function EvalMetricTiles({
  recall,
  precision,
  citationAccuracy,
  tracesPassed,
  tracesTotal,
  delta,
}: EvalMetricTilesProps) {
  const t = useTranslations("eval.dashboard.metrics");

  return (
    <div style={s.row}>
      <MetricCard
        label={t("recall")}
        value={formatPercent(recall)}
        delta={delta?.recall ?? undefined}
      />
      <MetricCard
        label={t("precision")}
        value={formatPercent(precision)}
        delta={delta?.precision ?? undefined}
      />
      <MetricCard
        label={t("citationAccuracy")}
        value={formatPercent(citationAccuracy)}
        delta={delta?.citationAccuracy ?? undefined}
      />
      <MetricCard label={t("tracesPassed")} value={`${tracesPassed}/${tracesTotal}`} />
    </div>
  );
}
