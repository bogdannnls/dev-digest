"use client";

import React from "react";
import type { ConventionCandidate } from "@devdigest/shared";
import { Button } from "@devdigest/ui";
import { useUpdateConvention } from "../../../../../../lib/hooks/conventions";

interface Props {
  candidate: ConventionCandidate;
  repoId: string;
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

export function ConventionCard({ candidate, repoId }: Props) {
  const update = useUpdateConvention(repoId);
  const [editing, setEditing] = React.useState(false);
  const [draftRule, setDraftRule] = React.useState(candidate.rule);

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
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
            {candidate.evidence_path}
          </span>
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
          kind={candidate.accepted ? "primary" : "ghost"}
          onClick={() => update.mutate({ id: candidate.id, patch: { accepted: true } })}
          disabled={update.isPending}
        >
          ✓ Accepted
        </Button>
        <Button
          kind={!candidate.accepted ? "danger" : "ghost"}
          onClick={() => update.mutate({ id: candidate.id, patch: { accepted: false } })}
          disabled={update.isPending}
        >
          ✕ Reject
        </Button>
      </div>
    </div>
  );
}
