"use client";

import { useTranslations } from "next-intl";
import type { AnnotatedFinding } from "../EvalResultsSplit/diffFindings";
import { s } from "./styles";

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "#e11d48",
  WARNING: "#f59e0b",
  SUGGESTION: "#3b82f6",
};

export function FindingRow({ finding }: { finding: AnnotatedFinding }) {
  const t = useTranslations("agents.eval.badge");

  return (
    <div style={s.row}>
      <span
        style={{
          ...s.dot,
          background: SEVERITY_COLOR[finding.severity] ?? "#9ca3af",
        }}
      />
      <span style={s.fileLine}>
        {finding.file}:{finding.start_line}
      </span>
      <span style={s.title}>{finding.title}</span>
      {finding.annotation === "new" && (
        <span style={{ ...s.badge, color: "#16a34a" }}>{t("new")}</span>
      )}
      {finding.annotation === "missing" && (
        <span style={{ ...s.badge, color: "#dc2626" }}>{t("missing")}</span>
      )}
    </div>
  );
}
