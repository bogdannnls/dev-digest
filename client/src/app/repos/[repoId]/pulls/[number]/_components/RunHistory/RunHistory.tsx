"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, CircularScore, type IconName } from "@devdigest/ui";
import type { RunSummary, PrCommit } from "@devdigest/shared";

/**
 * PR timeline — every agent run interleaved with the PR's commits, newest-first
 * and DB-backed so it survives reload. Showing commits between runs makes it
 * clear which commit each review ran against. Failed runs show their error
 * inline; clicking a run row opens its trace.
 *
 * The badge reflects the review OUTCOME, not just the run lifecycle: a finished
 * run that found blockers reads "rejected" (red), never a green "done". Outcome
 * is derived from the denormalized blocker/finding counts on the run row, so it
 * matches the CI gate (deterministic) rather than the model's verdict.
 */

type Outcome = { key: string; color: string; bg: string; icon: IconName };

function outcomeOf(run: RunSummary): Outcome {
  const status = run.status ?? "";
  if (status === "running")
    return { key: "running", color: "var(--accent)", bg: "var(--accent-bg)", icon: "RefreshCw" };
  if (status === "failed")
    return { key: "error", color: "var(--crit)", bg: "var(--crit-bg)", icon: "XCircle" };
  if (status === "cancelled")
    return { key: "cancelled", color: "var(--text-muted)", bg: "var(--bg-hover)", icon: "X" };
  // Settled ("done"): color by the deterministic outcome.
  if ((run.blockers ?? 0) > 0)
    return { key: "rejected", color: "var(--crit)", bg: "var(--crit-bg)", icon: "XCircle" };
  if ((run.findings_count ?? 0) > 0)
    return { key: "reviewed", color: "var(--warn)", bg: "var(--warn-bg)", icon: "MessageSquare" };
  return { key: "approved", color: "var(--ok)", bg: "var(--ok-bg)", icon: "CheckCircle" };
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  textAlign: "left",
};

const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 4,
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
};

// Commits are markers, not actions — lighter (dashed, transparent) so they read
// as separators between the runs they sit chronologically between.
const commitRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px dashed var(--border)",
  background: "transparent",
};

// Collapsible group header — one row summarising N commits, positioned in the
// timeline at the newest commit's timestamp. Uses a solid (not dashed) border
// so it reads as an actionable summary rather than an inline separator.
const commitsGroupHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  textAlign: "left",
  cursor: "pointer",
  font: "inherit",
  color: "inherit",
};

type TimelineItem =
  | { kind: "run"; ts: number; run: RunSummary }
  | { kind: "commits"; ts: number; commits: PrCommit[] };

/** Epoch ms for sorting; unparseable / missing timestamps sort last. */
function tsOf(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Date.parse(s);
  return Number.isNaN(n) ? 0 : n;
}

function CommitRow({ commit }: { commit: PrCommit }) {
  return (
    <div style={commitRowStyle}>
      <Icon.GitCommit size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
      <span className="mono" style={{ fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>
        {commit.sha.slice(0, 7)}
      </span>
      <span
        style={{
          fontSize: 12.5,
          color: "var(--text-secondary)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={commit.message}
      >
        {commit.message.split("\n")[0]}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{commit.author}</span>
      {commit.committed_at && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
          {new Date(commit.committed_at).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

function CommitsGroup({ commits }: { commits: PrCommit[] }) {
  const t = useTranslations("prReview");
  const [open, setOpen] = React.useState(false);
  const latest = commits[0]!;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t("timeline.commitsToggle")}
        style={commitsGroupHeaderStyle}
      >
        <Icon.GitCommit size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", flexShrink: 0 }}>
          {t("timeline.commitsCount", { count: commits.length })}
        </span>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
          {latest.sha.slice(0, 7)}
        </span>
        <span
          style={{
            fontSize: 12.5,
            color: "var(--text-secondary)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={latest.message}
        >
          {latest.message.split("\n")[0]}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{latest.author}</span>
        {latest.committed_at && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
            {new Date(latest.committed_at).toLocaleTimeString()}
          </span>
        )}
        <Icon.ChevronDown
          size={15}
          style={{
            color: "var(--text-muted)",
            transition: "transform 0.15s",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            flexShrink: 0,
          }}
        />
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 16 }}>
          {commits.map((c) => (
            <CommitRow key={c.sha} commit={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export function RunHistory({
  runs,
  commits = [],
  onOpenTrace,
  onGoToReview,
  onDelete,
}: {
  runs: RunSummary[];
  commits?: PrCommit[];
  /** Open the trace + log drawer for a run (the logs icon). */
  onOpenTrace: (runId: string) => void;
  /** Jump to this run's inline review accordion below (clicking the agent name). */
  onGoToReview?: (runId: string) => void;
  onDelete?: (runId: string) => void;
}) {
  const t = useTranslations("prReview");
  if (runs.length === 0 && commits.length === 0) return null;

  // Commits collapse into a SINGLE timeline entry positioned at the newest
  // commit's timestamp — so the group sorts against runs by time, but the user
  // sees one row (expandable) instead of one row per commit.
  const sortedCommits =
    commits.length > 0
      ? [...commits].sort((a, b) => tsOf(b.committed_at) - tsOf(a.committed_at))
      : [];

  const items: TimelineItem[] = [
    ...runs.map((run) => ({ kind: "run" as const, ts: tsOf(run.ran_at), run })),
    ...(sortedCommits.length > 0
      ? [
          {
            kind: "commits" as const,
            ts: tsOf(sortedCommits[0]!.committed_at),
            commits: sortedCommits,
          },
        ]
      : []),
  ].sort((a, b) => b.ts - a.ts);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => {
        if (item.kind === "commits") {
          return <CommitsGroup key="commits-group" commits={item.commits} />;
        }

        const r = item.run;
        const o = outcomeOf(r);
        const settled = r.status === "done";
        return (
          <div key={`run:${r.run_id}`} style={rowStyle}>
            <Badge color={o.color} bg={o.bg} icon={o.icon}>
              {t(`runStatus.${o.key}`)}
            </Badge>
            {settled && r.score != null && <CircularScore score={r.score} size={30} stroke={3} />}
            <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                <button
                  type="button"
                  onClick={() => onGoToReview?.(r.run_id)}
                  title={t("timeline.goToReview")}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    cursor: onGoToReview ? "pointer" : "default",
                    textDecoration: onGoToReview ? "underline" : "none",
                    textDecorationStyle: "dotted",
                    textUnderlineOffset: 3,
                  }}
                >
                  {r.agent_name ?? "Agent"}
                </button>{" "}
                <span className="mono" style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>
                  {r.provider}/{r.model}
                </span>
              </div>
              {r.status === "failed" && r.error && (
                <div
                  style={{ fontSize: 12, color: "var(--crit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={r.error}
                >
                  {r.error}
                </div>
              )}
              {settled && (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {t("runStatus.findings", { count: r.findings_count ?? 0 })}
                  {(r.blockers ?? 0) > 0 ? t("runStatus.blockers", { count: r.blockers ?? 0 }) : ""}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
              {r.ran_at && <span>{new Date(r.ran_at).toLocaleTimeString()}</span>}
            </div>
            <button
              type="button"
              title={t("timeline.openTrace")}
              aria-label={t("timeline.openTrace")}
              onClick={() => onOpenTrace(r.run_id)}
              style={iconBtnStyle}
            >
              <Icon.FileText size={13} />
            </button>
            {onDelete && r.status !== "running" && (
              <span
                role="button"
                aria-label={t("timeline.deleteRun")}
                title={t("timeline.deleteRun")}
                onClick={() => onDelete(r.run_id)}
                style={{ display: "inline-flex", padding: 3, borderRadius: 5, color: "var(--text-muted)", flexShrink: 0, cursor: "pointer" }}
              >
                <Icon.Trash size={13} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
