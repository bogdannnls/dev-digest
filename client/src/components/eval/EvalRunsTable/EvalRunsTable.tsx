/* EvalRunsTable — runs list with selection checkboxes for picking two runs to
   compare. Shared by the Evals tab and the Eval Dashboard (ui-architecture
   MUST.4 forbids cross-page imports, so this lives in `components/eval/`). */
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button } from "@devdigest/ui";
import type { EvalBatchRecord } from "@devdigest/shared";
import { formatCost, formatPercent, formatTimestamp } from "../format";
import { s } from "./styles";

const STATUS_COLOR: Record<EvalBatchRecord["status"], string> = {
  running: "var(--warn)",
  succeeded: "var(--ok)",
  failed: "var(--crit)",
};

export interface EvalRunsTableProps {
  runs: EvalBatchRecord[];
  /** Renders a "compare selected" action; called once exactly two rows are
   *  checked. Omit to render a plain, non-comparable list. */
  onCompare?: (aId: string, bId: string) => void;
}

export function EvalRunsTable({ runs, onCompare }: EvalRunsTableProps) {
  const t = useTranslations("eval.dashboard");
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  };

  return (
    <div style={s.wrap}>
      {onCompare && (
        <div style={s.actions}>
          <Button
            kind="secondary"
            size="sm"
            disabled={selected.length !== 2}
            onClick={() => {
              if (selected.length === 2) onCompare(selected[0]!, selected[1]!);
            }}
          >
            {t("compareSelected")}
          </Button>
        </div>
      )}
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
              <input
                type="checkbox"
                aria-label={t("selectRun")}
                checked={selected.includes(run.id)}
                onChange={() => toggle(run.id)}
                style={s.checkbox}
              />
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
    </div>
  );
}
