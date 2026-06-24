"use client";

import React from "react";
import { Skeleton, ErrorState, SectionLabel, CircularScore } from "@devdigest/ui";
import { useOverviewBrief } from "@/lib/hooks/overview";
import { VERDICT_META } from "../../../VerdictBanner/constants";

interface PrBriefCardProps {
  prId: string | null;
}

/** Human-readable verdict labels. Intentionally not i18n — PrBriefCard is a compact card
 *  outside the prReview intl namespace. labelKey values are taken from VERDICT_META. */
const VERDICT_LABEL: Record<keyof typeof VERDICT_META, string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
};

function formatUsd(n: number): string {
  // 3 decimals up to $1, 2 above. Local-first cost numbers are usually < $1.
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function PrBriefCard({ prId }: PrBriefCardProps) {
  const { data, isLoading, isError } = useOverviewBrief(prId);

  if (isError) {
    return (
      <section>
        <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
        <ErrorState title="Couldn't load the brief" body="Try again in a moment." />
      </section>
    );
  }

  if (isLoading || !data) {
    return (
      <section data-testid="pr-brief-loading">
        <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
        <Skeleton height={120} />
      </section>
    );
  }

  if (data.status === "no_runs") {
    return (
      <section>
        <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
        <div style={{ padding: 16, color: "var(--text-secondary, #6b7280)" }}>
          No review runs yet — kick off a review to see the verdict, score and cost here.
        </div>
      </section>
    );
  }

  const { verdict, summary, findingsCount, blockersCount, score, totalCost } = data.data;

  return (
    <section>
      <SectionLabel icon="Sparkles">PR Brief</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          gap: 16,
          padding: 16,
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 8,
          alignItems: "center",
        }}
      >
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            color: VERDICT_META[verdict].c,
            background: VERDICT_META[verdict].bg,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {VERDICT_LABEL[verdict]}
        </span>
        <div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>{summary}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary, #6b7280)" }}>
            {findingsCount} findings · {blockersCount} blockers ·{" "}
            {formatTokens(totalCost.tokensIn)} in / {formatTokens(totalCost.tokensOut)} out ·{" "}
            {formatUsd(totalCost.usd)}
          </div>
        </div>
        <div aria-label="PR score">
          {score == null ? (
            <span style={{ fontSize: 28, fontWeight: 700, color: "#9ca3af" }}>—</span>
          ) : (
            <CircularScore score={score} size={52} stroke={5} />
          )}
        </div>
      </div>
    </section>
  );
}
