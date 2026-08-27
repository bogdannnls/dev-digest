/* EvalRunComparison — compare modal: metric deltas plus the two system
   prompts shown side by side. Shared by the Evals tab and the Eval Dashboard
   (ui-architecture MUST.4 forbids cross-page imports). */
"use client";

import { useTranslations } from "next-intl";
import { Modal, Badge, Button } from "@devdigest/ui";
import type { EvalRunComparison as EvalRunComparisonData } from "@devdigest/shared";
import { deltaColor, formatCostDelta, formatPercentDelta } from "../format";
import { s } from "./styles";

export interface EvalRunComparisonProps {
  comparison: EvalRunComparisonData;
  onClose: () => void;
}

export function EvalRunComparison({ comparison, onClose }: EvalRunComparisonProps) {
  const t = useTranslations("eval");
  const { system_prompt_a, system_prompt_b, delta } = comparison;

  return (
    <Modal
      title={t("compare.title")}
      onClose={onClose}
      width={880}
      footer={
        <Button kind="secondary" size="sm" onClick={onClose}>
          {t("compare.close")}
        </Button>
      }
    >
      <div style={s.body}>
        <div style={s.deltaRow}>
          <DeltaTile label={t("dashboard.legend.recall")} value={delta.recall} />
          <DeltaTile label={t("dashboard.legend.precision")} value={delta.precision} />
          <DeltaTile label={t("dashboard.legend.citation")} value={delta.citation_accuracy} />
          <DeltaTile label={t("dashboard.table.cost")} value={delta.cost_usd} cost />
        </div>
        <div style={s.promptSection}>
          <h3 style={s.promptHeading}>{t("compare.promptDiffHeading")}</h3>
          <div style={s.promptColumns}>
            <div style={s.promptColumn}>
              <Badge>{t("compare.old")}</Badge>
              <pre style={s.promptBlock}>{system_prompt_a}</pre>
            </div>
            <div style={s.promptColumn}>
              <Badge>{t("compare.new")}</Badge>
              <pre style={s.promptBlock}>{system_prompt_b}</pre>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DeltaTile({ label, value, cost }: { label: string; value: number | null; cost?: boolean }) {
  const text = cost ? formatCostDelta(value) : formatPercentDelta(value);
  return (
    <div style={s.deltaTile}>
      <span style={s.deltaLabel}>{label}</span>
      <span style={{ ...s.deltaValue, color: deltaColor(value, cost) }}>{text}</span>
    </div>
  );
}
