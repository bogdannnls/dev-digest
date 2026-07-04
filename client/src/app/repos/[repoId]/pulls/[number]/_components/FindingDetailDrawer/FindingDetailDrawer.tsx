/* FindingDetailDrawer — right-side drawer opened from an inline finding badge
   inside the diff. Shows the same content a FindingCard would when expanded
   (severity, title, category, file:line, confidence, rationale, suggestion,
   accept/dismiss) but doesn't require leaving the Files-changed tab. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  CategoryTag,
  ConfidenceNum,
  Drawer,
  Markdown,
  MonoLink,
  SeverityBadge,
  type Category,
  type Severity,
} from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import { useFindingAction } from "@/lib/hooks/reviews";
import { githubBlobUrl } from "@/lib/github-urls";
import { lineLabel } from "../FindingCard/helpers";

export function FindingDetailDrawer({
  finding: f,
  prId,
  repoFullName,
  headSha,
  onClose,
}: {
  finding: FindingRecord;
  prId: string;
  repoFullName?: string | null;
  headSha?: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("prReview");
  const action = useFindingAction();
  const fileHref =
    repoFullName && headSha
      ? githubBlobUrl(repoFullName, headSha, f.file, f.start_line, f.end_line)
      : undefined;
  const accepted = !!f.accepted_at;
  const dismissed = !!f.dismissed_at;

  return (
    <Drawer
      width={560}
      onClose={onClose}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SeverityBadge severity={f.severity as Severity} compact />
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text-primary)",
              textDecoration: dismissed ? "line-through" : "none",
            }}
          >
            {f.title}
          </span>
          <CategoryTag category={f.category as Category} />
        </div>
      }
      subtitle={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <MonoLink href={fileHref}>
            {f.file}:{lineLabel(f)}
          </MonoLink>
          <ConfidenceNum value={f.confidence} />
          {accepted && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ok)" }}>
              {t("finding.accepted")}
            </span>
          )}
          {dismissed && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
              {t("finding.dismissed")}
            </span>
          )}
        </div>
      }
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="secondary"
            size="sm"
            icon="Check"
            disabled={action.isPending}
            active={accepted}
            onClick={() => action.mutate({ findingId: f.id, action: "accept", prId })}
          >
            {t("finding.accept")}
          </Button>
          <Button
            kind="ghost"
            size="sm"
            icon="X"
            disabled={action.isPending}
            active={dismissed}
            onClick={() => action.mutate({ findingId: f.id, action: "dismiss", prId })}
          >
            {t("finding.dismiss")}
          </Button>
        </div>
      }
    >
      <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" }}>
        <Markdown>{f.rationale}</Markdown>
      </div>
      {f.suggestion && (
        <div style={{ marginTop: 18 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              marginBottom: 8,
              textTransform: "uppercase",
            }}
          >
            {t("finding.suggestedFix")}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" }}>
            <Markdown>{f.suggestion}</Markdown>
          </div>
        </div>
      )}
    </Drawer>
  );
}
