"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon, Skeleton, SectionLabel, Button, SeverityBadge } from "@devdigest/ui";
import type { IconName } from "@devdigest/ui";
import type { FindingRecord, RiskAreaIcon, RiskSeverity } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useOverviewBriefSynth } from "@/lib/hooks/overview";
import { usePrReviews } from "@/lib/hooks/reviews";
import { s } from "./styles";

interface WhyRiskBriefCardProps {
  prId: string | null;
  /** `/repos/:repoId/pulls/:number` — used to deep-link Review-focus items into
   *  the Findings tab, matching the pattern `FindingsCell` already uses. */
  baseHref: string;
}

const RISK_ICON: Record<RiskAreaIcon, IconName> = {
  shield: "Shield",
  package: "Boxes",
  zap: "Zap",
  database: "Database",
  globe: "Globe",
};

/** Mirrors IntentCard's per-icon colour mapping (spec §8.5 rationale) — kept
 *  as a local copy since IntentCard doesn't export its constants. */
const RISK_ICON_COLOR: Record<RiskAreaIcon, string> = {
  shield: "#3b82f6",
  package: "#a855f7",
  zap: "#f59e0b",
  database: "#10b981",
  globe: "#14b8a6",
};

const RISK_LEVEL_COLOR: Record<RiskSeverity, string> = {
  high: "var(--crit, #dc2626)",
  medium: "var(--warn, #d97706)",
  low: "var(--ok, #16a34a)",
};

const RISK_LEVEL_ICON: Record<RiskSeverity, IconName> = {
  high: "AlertOctagon",
  medium: "AlertTriangle",
  low: "CheckCircle",
};

function formatUsd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function WhyRiskBriefCard({ prId, baseHref }: WhyRiskBriefCardProps) {
  const t = useTranslations("whyRiskBrief");
  const router = useRouter();
  const toast = useToast();
  const { status, data, missing, staleReasons, error, progress, isRefreshing, refresh } =
    useOverviewBriefSynth(prId);
  // Findings the client already holds for the PR — AC-43 resolves
  // reviewFocus[].findingId → file:line/severity/title from here, no new endpoint.
  const { data: reviews } = usePrReviews(prId);

  const findingsById = React.useMemo(() => {
    const map = new Map<string, FindingRecord>();
    for (const review of reviews ?? []) {
      for (const finding of review.findings) {
        map.set(finding.id, finding);
      }
    }
    return map;
  }, [reviews]);

  // Disable Refresh while any compute is in flight (mirrors IntentCard); the
  // `not_ready` branch below hides the control entirely instead (AC-42).
  const refreshDisabled = status === "loading" || status === "computing" || isRefreshing;

  const handleRefresh = React.useCallback(async () => {
    try {
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const retryAfter =
          typeof e.details === "object" && e.details && "retryAfterSeconds" in e.details
            ? Number((e.details as { retryAfterSeconds?: number }).retryAfterSeconds)
            : null;
        toast.error(
          retryAfter && !Number.isNaN(retryAfter)
            ? t("refreshError.rateLimited", { seconds: retryAfter })
            : t("refreshError.rateLimitedGeneric"),
        );
        return;
      }
      toast.error(t("refreshError.generic"));
    }
  }, [refresh, toast, t]);

  const refreshButton = (
    <Button
      kind="ghost"
      size="sm"
      icon="RefreshCw"
      onClick={handleRefresh}
      disabled={refreshDisabled}
      aria-label={t("refresh")}
    >
      {t("refresh")}
    </Button>
  );

  if (status === "loading" || status === "idle") {
    return (
      <section data-testid="why-risk-brief-loading">
        <SectionLabel icon="Sparkles">{t("title")}</SectionLabel>
        <Skeleton height={120} />
      </section>
    );
  }

  if (status === "not_ready") {
    // AC-41: name which input(s) are missing rather than a generic empty state.
    // AC-42: no Refresh control at all while not_ready — refreshing can't
    // succeed until the missing input(s) exist.
    const inputLabels = (missing ?? []).map((m) =>
      m === "intent" ? t("notReady.missingIntent") : t("notReady.missingReview"),
    );
    return (
      <section data-testid="why-risk-brief-not-ready">
        <SectionLabel icon="Sparkles">{t("title")}</SectionLabel>
        <div style={s.notReadyBox}>
          {t("notReady.message", { inputs: inputLabels.join(` ${t("notReady.and")} `) })}
        </div>
      </section>
    );
  }

  if (status === "computing") {
    return (
      <section data-testid="why-risk-brief-computing">
        <SectionLabel icon="Sparkles" right={refreshButton}>
          {t("title")}
        </SectionLabel>
        <Skeleton height={90} />
        <div style={{ ...s.progressLine, marginTop: 10 }}>
          <Icon.RefreshCw size={14} style={{ animation: "ddspin 1s linear infinite" }} />
          <span>{progress ?? t("computing.progress")}</span>
        </div>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section data-testid="why-risk-brief-error">
        <SectionLabel icon="Sparkles" right={refreshButton}>
          {t("title")}
        </SectionLabel>
        <div style={s.errorText}>{error ?? t("error.generic")}</div>
      </section>
    );
  }

  // status is "ready" or "ready-stale" here; data is guaranteed non-null.
  const brief = data!;
  const RiskLevelIcon = Icon[RISK_LEVEL_ICON[brief.riskLevel]];

  return (
    <section>
      <SectionLabel icon="Sparkles" right={refreshButton}>
        {t("title")}
      </SectionLabel>
      <div style={s.card}>
        {status === "ready-stale" && staleReasons && !isRefreshing && (
          <div style={s.staleBanner} role="status">
            <span>
              {t("stale.banner", {
                reasons: staleReasons.map((r) => t(`stale.reason.${r}`)).join(" and "),
              })}
            </span>
          </div>
        )}

        {isRefreshing && (
          <div style={s.refreshingBanner} role="status" data-testid="why-risk-brief-refreshing">
            <Icon.RefreshCw size={14} style={{ animation: "ddspin 1s linear infinite" }} />
            <span>{progress ?? t("computing.progress")}</span>
          </div>
        )}

        <div style={s.what}>{brief.what}</div>
        <div style={s.why}>{brief.why}</div>

        <div style={s.riskLevelRow}>
          <span style={{ ...s.riskLevelBadge, color: RISK_LEVEL_COLOR[brief.riskLevel] }}>
            <RiskLevelIcon size={14} />
            {t(`riskLevel.${brief.riskLevel}`)}
          </span>
        </div>

        {brief.risks.length > 0 && (
          <div style={s.riskRow}>
            {brief.risks.map((risk, i) => {
              const RiskIcon = Icon[RISK_ICON[risk.icon]];
              return (
                <span
                  key={i}
                  style={s.riskChip}
                  title={risk.fileRef ? `${risk.fileRef.file}:${risk.fileRef.line}` : undefined}
                >
                  <RiskIcon size={12} style={{ color: RISK_ICON_COLOR[risk.icon] }} />
                  {risk.label}
                </span>
              );
            })}
          </div>
        )}

        {brief.reviewFocus.length > 0 && (
          <div>
            <div style={s.reviewFocusHeading}>{t("reviewFocus.heading")}</div>
            {/* Real ordered list with keyboard-navigable links (AC-44). Explicit
                role="list" survives list-style removal (some ATs drop the
                implicit list semantics once list-style is none). */}
            <ol style={s.reviewFocusList} role="list">
              {brief.reviewFocus.map((item, i) => {
                // AC-43: resolve findingId -> file/line/severity/title from the
                // findings the client already holds; navigation itself only
                // needs the id, so a not-yet-loaded findings query never
                // breaks the link.
                const finding = findingsById.get(item.findingId);
                const target = `${baseHref}?tab=findings#finding-${item.findingId}`;
                return (
                  <li key={item.findingId} style={s.reviewFocusItem}>
                    <a
                      href={target}
                      style={s.reviewFocusLink}
                      onClick={(e) => {
                        e.preventDefault();
                        router.push(target);
                      }}
                    >
                      <span style={s.reviewFocusRank}>{i + 1}</span>
                      <span style={s.reviewFocusBody}>
                        <span style={s.reviewFocusTitleRow}>
                          {finding && <SeverityBadge severity={finding.severity} compact />}
                          <span style={s.reviewFocusTitle}>
                            {finding?.title ?? t("reviewFocus.unresolvedTitle")}
                          </span>
                        </span>
                        {finding && (
                          <span style={s.reviewFocusFileLine}>
                            {finding.file}:{finding.start_line}
                          </span>
                        )}
                        <span style={s.reviewFocusNote}>{item.note}</span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div style={s.footer}>
          Computed {formatRelativeTime(brief.computedAt)} · {formatUsd(brief.cost.usd)} ·{" "}
          {brief.model}
        </div>
      </div>
    </section>
  );
}
