"use client";

import React from "react";
import { Skeleton, ErrorState, SectionLabel } from "@devdigest/ui";
import { useOverviewBrief } from "@/lib/hooks/overview";

interface PrBriefCardProps {
  prId: string | null;
}

const VERDICT_LABEL: Record<string, string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
  no_runs: "No reviews yet",
};

const VERDICT_COLOR: Record<string, string> = {
  approve: "#16a34a",
  comment: "#2563eb",
  request_changes: "#dc2626",
  no_runs: "#6b7280",
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
            color: "white",
            background: VERDICT_COLOR[verdict] ?? VERDICT_COLOR.no_runs,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {VERDICT_LABEL[verdict] ?? verdict}
        </span>
        <div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>{summary}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary, #6b7280)" }}>
            {findingsCount} findings · {blockersCount} blockers ·{" "}
            {formatTokens(totalCost.tokensIn)} in / {formatTokens(totalCost.tokensOut)} out ·{" "}
            {formatUsd(totalCost.usd)}
          </div>
        </div>
        <div
          style={{ fontSize: 28, fontWeight: 700, color: score == null ? "#9ca3af" : undefined }}
          aria-label="PR score"
        >
          {score == null ? "—" : score}
        </div>
      </div>
    </section>
  );
}
