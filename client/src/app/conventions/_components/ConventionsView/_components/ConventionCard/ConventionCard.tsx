"use client";

import React from "react";
import type { ConventionCandidate } from "@devdigest/shared";
import { Button } from "@devdigest/ui";
import { useUpdateConvention } from "../../../../../../lib/hooks/conventions";
import { repoBlobUrl } from "../../../../../../lib/repo-source-urls";

interface RepoSource {
  provider: "github" | "bitbucket";
  full_name: string;
  default_branch: string;
}

interface Props {
  candidate: ConventionCandidate;
  repoId: string;
  repo?: RepoSource | null;
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? "var(--ok)" : value >= 0.5 ? "var(--warn)" : "var(--crit)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
      <div style={{ flex: 1, height: 4, background: "var(--bg-hover)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span>{pct}%</span>
    </div>
  );
}

export function ConventionCard({ candidate, repoId, repo }: Props) {
  const update = useUpdateConvention(repoId);
  const [editing, setEditing] = React.useState(false);
  const [draftRule, setDraftRule] = React.useState(candidate.rule);

  const evidenceUrl =
    repo && candidate.evidence_path
      ? repoBlobUrl(
          repo.provider,
          repo.full_name,
          repo.default_branch,
          candidate.evidence_path,
          candidate.evidence_start_line ?? null,
          candidate.evidence_end_line ?? null,
        )
      : null;
  const evidenceLineLabel =
    candidate.evidence_start_line != null
      ? candidate.evidence_end_line && candidate.evidence_end_line !== candidate.evidence_start_line
        ? `:${candidate.evidence_start_line}-${candidate.evidence_end_line}`
        : `:${candidate.evidence_start_line}`
      : "";

  const saveEdit = () => {
    update.mutate({ id: candidate.id, patch: { rule: draftRule } });
    setEditing(false);
  };

  return (
    <div
      style={{
        border: `1px solid ${candidate.accepted ? "var(--ok)" : "var(--border)"}`,
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
        background: candidate.accepted ? "var(--ok-bg, #052e1c)" : "var(--bg-elevated)",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* Category badge + edit button */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
          background: "var(--bg-hover)", color: "var(--text-secondary)",
          letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {candidate.category}
        </span>
        <div style={{ flex: 1 }} />
        <Button kind="ghost" onClick={() => setEditing(!editing)}>Edit</Button>
      </div>

      {/* Rule text / inline editor */}
      {editing ? (
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={draftRule}
            onChange={(e) => setDraftRule(e.target.value)}
            rows={3}
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 6,
              border: "1px solid var(--border-strong)", background: "var(--bg)",
              color: "var(--text-primary)", fontSize: 13, resize: "vertical", boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <Button kind="primary" onClick={saveEdit} disabled={update.isPending}>Save</Button>
            <Button kind="ghost" onClick={() => { setEditing(false); setDraftRule(candidate.rule); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 14, marginBottom: 8, color: "var(--text-primary)" }}>{candidate.rule}</p>
      )}

      {/* Evidence code block */}
      {candidate.evidence_path && (
        <div style={{ marginBottom: 10 }}>
          {evidenceUrl ? (
            <a
              href={evidenceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${candidate.evidence_path} on ${repo?.provider === "bitbucket" ? "Bitbucket" : "GitHub"}`}
              style={{
                fontSize: 11,
                color: "var(--accent)",
                fontFamily: "monospace",
                textDecoration: "none",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >
              {candidate.evidence_path}{evidenceLineLabel} ↗
            </a>
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
              {candidate.evidence_path}{evidenceLineLabel}
            </span>
          )}
          {candidate.evidence_snippet && (
            <pre style={{
              marginTop: 4, padding: "8px 12px", background: "var(--bg)",
              borderRadius: 4, fontSize: 12, overflow: "auto",
              color: "var(--text-secondary)", border: "1px solid var(--border)",
            }}>
              <code>{candidate.evidence_snippet}</code>
            </pre>
          )}
        </div>
      )}

      {/* Confidence bar + accept/reject */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <ConfidenceBar value={candidate.confidence ?? null} />
        </div>
        <Button
          kind="ghost"
          onClick={() => update.mutate({ id: candidate.id, patch: { accepted: true } })}
          disabled={update.isPending}
          aria-pressed={candidate.accepted}
          style={{
            background: candidate.accepted ? "var(--ok)" : "transparent",
            color: candidate.accepted ? "#fff" : "var(--ok)",
            borderColor: "var(--ok)",
            opacity: 1,
          }}
        >
          {candidate.accepted ? "✓ Accepted" : "Accept"}
        </Button>
        <Button
          kind="ghost"
          onClick={() => update.mutate({ id: candidate.id, patch: { accepted: false } })}
          disabled={update.isPending}
          aria-pressed={!candidate.accepted}
          style={{
            background: !candidate.accepted ? "var(--crit)" : "transparent",
            color: !candidate.accepted ? "#fff" : "var(--crit)",
            borderColor: "var(--crit)",
            opacity: 1,
          }}
        >
          {!candidate.accepted ? "✕ Rejected" : "Reject"}
        </Button>
      </div>
    </div>
  );
}
