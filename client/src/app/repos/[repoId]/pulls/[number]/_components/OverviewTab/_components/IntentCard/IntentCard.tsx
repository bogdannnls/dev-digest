"use client";

import React from "react";
import { Icon, Skeleton, SectionLabel, Button } from "@devdigest/ui";
import type { IconName } from "@devdigest/ui";
import type {
  IntentReferenceDto,
  IntentReferenceStatus,
  PrIntentStaleReason,
  RiskAreaIcon,
} from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useOverviewIntent } from "@/lib/hooks/overview";
import { s } from "./styles";

interface IntentCardProps {
  prId: string | null;
}

const RISK_ICON: Record<RiskAreaIcon, IconName> = {
  shield: "Shield",
  package: "Boxes",
  zap: "Zap",
  database: "Database",
  globe: "Globe",
};

/**
 * Per-icon colour for risk-area chips. Tailwind-palette mid-tones — readable
 * on both light and dark backgrounds without needing per-theme overrides.
 * Semantic mapping matches the spec §8.5 rationale (shield=security-blue,
 * zap=performance-amber, database=data-emerald, globe=network-teal, and
 * package=purple for "packaging/deps", the only one without an obvious tint).
 */
const RISK_ICON_COLOR: Record<RiskAreaIcon, string> = {
  shield: "#3b82f6",
  package: "#a855f7",
  zap: "#f59e0b",
  database: "#10b981",
  globe: "#14b8a6",
};

const STALE_REASON_LABEL: Record<PrIntentStaleReason, string> = {
  head_sha: "the PR was updated",
  body: "the description changed",
};

function staleBannerText(reasons: PrIntentStaleReason[]): string {
  const parts = reasons.map((r) => STALE_REASON_LABEL[r]);
  return `Stale — ${parts.join(" and ")}.`;
}

type ChipTone = "ok" | "warn" | "crit";

const REFERENCE_STATUS_TONE: Record<IntentReferenceStatus, ChipTone> = {
  ok: "ok",
  no_auth: "warn",
  not_allowlisted: "warn",
  not_found: "warn",
  unreachable: "crit",
  timeout: "crit",
  too_large: "crit",
  parse_error: "crit",
};

const REFERENCE_STATUS_LABEL: Record<IntentReferenceStatus, string> = {
  ok: "ok",
  no_auth: "no access",
  not_allowlisted: "not allow-listed",
  not_found: "not found",
  unreachable: "unreachable",
  timeout: "timed out",
  too_large: "too large",
  parse_error: "parse error",
};

const TONE_ICON: Record<ChipTone, IconName> = {
  ok: "CheckCircle",
  warn: "AlertTriangle",
  crit: "XCircle",
};

const TONE_COLOR: Record<ChipTone, string> = {
  ok: "var(--ok, #16a34a)",
  warn: "var(--warn, #d97706)",
  crit: "var(--crit, #dc2626)",
};

function referenceLabel(ref: IntentReferenceDto): string {
  if (ref.kind === "github_issue") return `github #${ref.id}`;
  if (ref.kind === "url") return ref.id.length > 20 ? `${ref.id.slice(0, 20)}…` : ref.id;
  return ref.id;
}

function ReferenceChip({ reference }: { reference: IntentReferenceDto }) {
  const tone = REFERENCE_STATUS_TONE[reference.status];
  const ToneIcon = Icon[TONE_ICON[tone]];
  return (
    <span
      style={s.referenceChip}
      title={`${reference.id} — ${REFERENCE_STATUS_LABEL[reference.status]}`}
    >
      <ToneIcon size={12} style={{ color: TONE_COLOR[tone] }} />
      {referenceLabel(reference)}
    </span>
  );
}

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

export function IntentCard({ prId }: IntentCardProps) {
  const { status, data, staleReasons, error, progress, isRefreshing, refresh } =
    useOverviewIntent(prId);
  const toast = useToast();
  // Disable Refresh while any compute is in flight: server-driven `computing`
  // (first-view cold path), OR user-initiated `isRefreshing` (this hook's
  // refresh() clicked the button). Prevents double-firing the rate limit.
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
            ? `You just refreshed — try again in ${retryAfter}s`
            : "You just refreshed — try again in a moment",
        );
        return;
      }
      toast.error("Couldn't refresh the intent card.");
    }
  }, [refresh, toast]);

  const refreshButton = (
    <Button
      kind="ghost"
      size="sm"
      icon="RefreshCw"
      onClick={handleRefresh}
      disabled={refreshDisabled}
      aria-label="Refresh intent"
    >
      Refresh
    </Button>
  );

  if (status === "loading" || status === "idle") {
    // Spec §13.3: loading has "no header actions" — no Refresh button at all
    // here (distinct from `computing`, which shows a disabled Refresh).
    return (
      <section data-testid="intent-loading">
        <SectionLabel icon="Target">Intent</SectionLabel>
        <Skeleton height={120} />
      </section>
    );
  }

  if (status === "computing") {
    return (
      <section data-testid="intent-computing">
        <SectionLabel icon="Target" right={refreshButton}>
          Intent
        </SectionLabel>
        <Skeleton height={90} />
        <div style={{ ...s.progressLine, marginTop: 10 }}>
          <Icon.RefreshCw size={14} style={{ animation: "ddspin 1s linear infinite" }} />
          <span>{progress ?? "Extracting intent…"}</span>
        </div>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section>
        <SectionLabel icon="Target" right={refreshButton}>
          Intent
        </SectionLabel>
        <div style={s.errorText}>{error ?? "Couldn't load the intent card."}</div>
      </section>
    );
  }

  // status is "ready" or "ready-stale" here; data is guaranteed non-null.
  const intent = data!;

  return (
    <section>
      <SectionLabel icon="Target" right={refreshButton}>
        Intent
      </SectionLabel>
      <div style={s.card}>
        {status === "ready-stale" && staleReasons && !isRefreshing && (
          <div style={s.staleBanner} role="status">
            <span>{staleBannerText(staleReasons)}</span>
          </div>
        )}

        {isRefreshing && (
          <div style={s.refreshingBanner} role="status" data-testid="intent-refreshing">
            <Icon.RefreshCw size={14} style={{ animation: "ddspin 1s linear infinite" }} />
            <span>{progress ?? "Refreshing intent…"}</span>
          </div>
        )}

        <div style={s.goal}>{intent.goal}</div>

        <div style={s.scopeGrid}>
          <div>
            <div style={s.scopeColumnLabel}>In scope</div>
            <ul style={s.scopeList}>
              {intent.inScope.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <div style={s.scopeColumnLabel}>Out of scope</div>
            <ul style={s.scopeList}>
              {intent.outOfScope.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        {intent.riskAreas.length > 0 && (
          <div style={s.riskRow}>
            {intent.riskAreas.map((risk, i) => {
              const RiskIcon = Icon[RISK_ICON[risk.icon]];
              return (
                <span key={i} style={s.riskChip}>
                  <RiskIcon size={12} style={{ color: RISK_ICON_COLOR[risk.icon] }} />
                  {risk.label}
                </span>
              );
            })}
          </div>
        )}

        {intent.references.length > 0 && (
          <div style={s.referenceRow}>
            <span style={s.referenceLabel}>Sources:</span>
            {intent.references.map((ref, i) => (
              <ReferenceChip key={`${ref.kind}-${ref.id}-${i}`} reference={ref} />
            ))}
          </div>
        )}

        <div style={s.footer}>
          Computed {formatRelativeTime(intent.computedAt)} · {formatUsd(intent.cost.usd)} ·{" "}
          {intent.model}
        </div>
      </div>
    </section>
  );
}
