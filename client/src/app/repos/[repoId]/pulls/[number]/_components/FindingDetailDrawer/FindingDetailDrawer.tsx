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
  Icon,
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
import { SEV_COLOR, SEV_COLOR_FALLBACK } from "../FindingCard/constants";

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
  const sevColor = SEV_COLOR[f.severity] ?? SEV_COLOR_FALLBACK;
  const fileHref =
    repoFullName && headSha
      ? githubBlobUrl(repoFullName, headSha, f.file, f.start_line, f.end_line)
      : undefined;
  const accepted = !!f.accepted_at;
  const dismissed = !!f.dismissed_at;

  return (
    <Drawer
      width={580}
      onClose={onClose}
      title={
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ paddingTop: 2 }}>
            <SeverityBadge severity={f.severity as Severity} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: "-0.01em",
                lineHeight: 1.35,
                color: "var(--text-primary)",
                textDecoration: dismissed ? "line-through" : "none",
              }}
            >
              {f.title}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              <CategoryTag category={f.category as Category} />
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
          </div>
        </div>
      }
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
          <Button
            kind="primary"
            size="sm"
            icon="Check"
            disabled={action.isPending}
            active={accepted}
            onClick={() => action.mutate({ findingId: f.id, action: "accept", prId })}
          >
            {t("finding.accept")}
          </Button>
        </div>
      }
    >
      {/* Severity accent strip — a 3px colored bar at the top of the body so the
         "critical/warning" signal remains legible even when the header scrolls
         out of view on long rationales. Uses negative margins to bleed past the
         Drawer's built-in 24px body padding. */}
      <div
        aria-hidden
        style={{
          margin: "-24px -24px 20px",
          height: 3,
          background: sevColor,
          opacity: 0.9,
        }}
      />

      {/* File chip — mono, icon-prefixed, visually anchors the finding to a
         concrete location. Clickable when we have a github deep-link. */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            fontSize: 13,
          }}
        >
          <Icon.FileText size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <MonoLink href={fileHref}>
            {f.file}:{lineLabel(f)}
          </MonoLink>
        </div>
      </div>

      {/* Rationale — the "why". Small uppercase label + prose with a softer
         color and a bit more line-height for readability. Hardcoded label
         because the reviewer-side prReview.json has no `rationale` key today. */}
      <SectionLabel icon="Info" label="Rationale" />
      <div style={proseStyle}>
        <Markdown>{f.rationale}</Markdown>
      </div>

      {/* Suggested fix — presented as its own card so it visually reads as
         "advice" rather than "more of the same". Green (--ok) accent because
         it's constructive; Lightbulb icon reinforces "here's an idea." */}
      {f.suggestion && (
        <div
          style={{
            marginTop: 22,
            padding: "14px 16px",
            borderRadius: 8,
            borderStyle: "solid",
            borderColor: "var(--border)",
            borderWidth: 1,
            borderLeftWidth: 3,
            borderLeftColor: "var(--ok)",
            background: "var(--bg-elevated)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
            }}
          >
            <Icon.Lightbulb size={15} style={{ color: "var(--ok)" }} />
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ok)",
              }}
            >
              {t("finding.suggestedFix")}
            </span>
          </div>
          <div style={proseStyle}>
            <Markdown>{f.suggestion}</Markdown>
          </div>
        </div>
      )}
    </Drawer>
  );
}

const proseStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: "var(--text-secondary)",
};

/** Small labeled section header — uppercase, icon-prefixed. */
function SectionLabel({ icon, label }: { icon: keyof typeof Icon; label: string }) {
  const I = Icon[icon] as React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 10,
      }}
    >
      <I size={14} style={{ color: "var(--text-muted)" }} />
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
    </div>
  );
}
