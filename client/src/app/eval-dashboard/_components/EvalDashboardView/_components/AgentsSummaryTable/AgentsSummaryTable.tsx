/* AgentsSummaryTable — one row per agent: name + model, eval case count, and
   recall/precision/citation accuracy each paired with a sparkline over that
   agent's trend. Page-private to the Eval Dashboard landing view; reuses the
   shared `formatPercent` (em dash for a `null` metric, contract 3.4) rather
   than a local formatter. */
"use client";

import { useTranslations } from "next-intl";
import { Badge, Icon, Sparkline } from "@devdigest/ui";
import type { EvalDashboardAgentSummary } from "@devdigest/shared";
import { formatPercent } from "@/components/eval/format";
import { s } from "./styles";

export interface AgentsSummaryTableProps {
  agents: EvalDashboardAgentSummary[];
  onSelect: (agentId: string) => void;
}

export function AgentsSummaryTable({ agents, onSelect }: AgentsSummaryTableProps) {
  const t = useTranslations("eval");

  return (
    <div role="table" style={s.table}>
      <div role="row" style={s.headerRow}>
        <span role="columnheader" style={s.cell} aria-hidden="true" />
        <span role="columnheader" style={s.cell}>
          {t("evalsTab.casesHeading")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("dashboard.metrics.recall")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("dashboard.metrics.precision")}
        </span>
        <span role="columnheader" style={s.cell}>
          {t("dashboard.metrics.citationAccuracy")}
        </span>
        <span role="columnheader" style={s.cell} aria-hidden="true" />
      </div>
      {agents.map((agent) => (
        <div
          role="row"
          key={agent.agent_id}
          style={s.row}
          onClick={() => onSelect(agent.agent_id)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect(agent.agent_id);
          }}
        >
          <span role="cell" style={s.cell}>
            <span style={s.agentName}>{agent.agent_name}</span>
            <Badge color="var(--text-secondary)" mono>
              {agent.model}
            </Badge>
          </span>
          <span role="cell" style={s.cell}>
            {agent.cases_total}
          </span>
          <MetricCell value={agent.last_run?.recall ?? null} trend={agent.trend.map((p) => p.recall)} color="var(--accent)" />
          <MetricCell value={agent.last_run?.precision ?? null} trend={agent.trend.map((p) => p.precision)} color="var(--ok)" />
          <MetricCell
            value={agent.last_run?.citation_accuracy ?? null}
            trend={agent.trend.map((p) => p.citation_accuracy)}
            color="var(--warn)"
          />
          <span role="cell" style={s.chevron} aria-hidden="true">
            <Icon.ChevronRight size={16} />
          </span>
        </div>
      ))}
    </div>
  );
}

function MetricCell({ value, trend, color }: { value: number | null; trend: number[]; color: string }) {
  return (
    <span role="cell" style={s.metricCell}>
      <span>{formatPercent(value)}</span>
      <Sparkline data={trend} color={color} w={44} h={18} />
    </span>
  );
}
