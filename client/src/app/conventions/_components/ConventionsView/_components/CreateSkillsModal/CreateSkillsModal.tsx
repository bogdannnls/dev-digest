"use client";

import React from "react";
import type { ConventionCandidate, SkillType } from "@devdigest/shared";
import { Button, Modal } from "@devdigest/ui";
import { useToast } from "../../../../../../lib/toast";
import {
  useCreateSkillsFromConventions,
  type SkillOverride,
} from "../../../../../../lib/hooks/conventions";
import { useAgents } from "../../../../../../lib/hooks/agents";
import { repoBlobUrl } from "../../../../../../lib/repo-source-urls";
import { suggestSkillType } from "../../../../../../lib/skill-type-suggest";

const TYPE_OPTIONS: ReadonlyArray<{ value: SkillType; label: string }> = [
  { value: "rubric", label: "Rubric" },
  { value: "convention", label: "Convention" },
  { value: "security", label: "Security" },
  { value: "custom", label: "Custom" },
];

interface RepoSource {
  provider: "github" | "bitbucket";
  full_name: string;
  default_branch: string;
}

interface Props {
  repoId: string;
  repoSlug: string;
  candidates: ConventionCandidate[];
  repo?: RepoSource | null;
  onClose: () => void;
}

interface SkillDraft {
  category: string;
  name: string;
  description: string;
  type: SkillType;
  suggestedType: SkillType | null;
  items: ConventionCandidate[];
}

function autoDescription(category: string, count: number, repoSlug: string): string {
  return `${count} ${category} convention${count > 1 ? "s" : ""} from ${repoSlug}`;
}

function autoType(items: ConventionCandidate[]): SkillType | null {
  const text = items.map((c) => c.rule).join("\n");
  return suggestSkillType(text)?.type ?? null;
}

export function CreateSkillsModal({ repoId, repoSlug, candidates, repo, onClose }: Props) {
  const toast = useToast();
  const create = useCreateSkillsFromConventions(repoId);
  const { data: agents } = useAgents();
  const [agentId, setAgentId] = React.useState("");

  const initialDrafts = React.useMemo<SkillDraft[]>(() => {
    const map = new Map<string, ConventionCandidate[]>();
    for (const c of candidates) {
      const g = map.get(c.category) ?? [];
      g.push(c);
      map.set(c.category, g);
    }
    return [...map.entries()].map(([category, items]) => {
      const suggested = autoType(items);
      return {
        category,
        name: `${repoSlug}-${category}`,
        description: autoDescription(category, items.length, repoSlug),
        type: suggested ?? "convention",
        suggestedType: suggested,
        items,
      };
    });
  }, [candidates, repoSlug]);

  // User edits live in a sparse overlay keyed by category. We derive `drafts`
  // by merging the overlay onto `initialDrafts` at render time, so when
  // `candidates` changes (e.g. accept/reject runs in the background) we pick up
  // the new groupings without throwing away the user's in-progress edits.
  type DraftPatch = Partial<Pick<SkillDraft, "name" | "description" | "type">>;
  const [edits, setEdits] = React.useState<Record<string, DraftPatch>>({});

  const drafts = React.useMemo<SkillDraft[]>(
    () => initialDrafts.map((d) => ({ ...d, ...edits[d.category] })),
    [initialDrafts, edits],
  );

  const updateDraft = (category: string, patch: DraftPatch) => {
    setEdits((prev) => ({ ...prev, [category]: { ...prev[category], ...patch } }));
  };

  const hasInvalid = drafts.some((d) => d.name.trim().length === 0);

  const handleCreate = () => {
    const overrides: SkillOverride[] = drafts.map((d) => ({
      category: d.category,
      name: d.name.trim(),
      description: d.description.trim() || undefined,
      type: d.type,
    }));
    create.mutate(
      { agent_id: agentId || undefined, overrides },
      {
        onSuccess: (data) => {
          toast.success(
            `${data.skills.length} skill${data.skills.length > 1 ? "s" : ""} created and added to Skills Lab`,
          );
          onClose();
        },
        onError: () => toast.error("Failed to create skills"),
      },
    );
  };

  const footer = (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <Button kind="ghost" onClick={onClose} disabled={create.isPending}>
        Cancel
      </Button>
      <Button
        kind="primary"
        onClick={handleCreate}
        disabled={create.isPending || drafts.length === 0 || hasInvalid}
      >
        {create.isPending
          ? "Creating…"
          : `Create ${drafts.length} skill${drafts.length > 1 ? "s" : ""} ✦`}
      </Button>
    </div>
  );

  return (
    <Modal title="Create skill from conventions" onClose={onClose} footer={footer}>
      <div style={{ padding: "20px 24px" }}>
        <div
          style={{
            marginBottom: 18,
            padding: "10px 14px",
            borderRadius: 6,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            fontSize: 13,
            color: "var(--text-secondary)",
          }}
        >
          ✦ Merged from {candidates.length} accepted convention{candidates.length > 1 ? "s" : ""} in{" "}
          <span style={{ color: "var(--accent)" }}>{repoSlug}</span>. Name and description are
          editable below — everything else is saved as-is.
        </div>

        {drafts.map((d) => {
          const placeholderDesc = autoDescription(d.category, d.items.length, repoSlug);
          const nameInvalid = d.name.trim().length === 0;
          return (
            <div
              key={d.category}
              style={{
                marginBottom: 12,
                padding: 16,
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  letterSpacing: "0.04em",
                  marginBottom: 12,
                }}
              >
                {d.category} · {d.items.length} convention{d.items.length > 1 ? "s" : ""}
              </div>

              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Skill name
              </label>
              <input
                value={d.name}
                onChange={(e) => updateDraft(d.category, { name: e.target.value })}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: `1px solid ${nameInvalid ? "var(--crit)" : "var(--border-strong)"}`,
                  background: "var(--bg)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  fontFamily: "monospace",
                  boxSizing: "border-box",
                  marginBottom: 10,
                }}
              />

              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Description
              </label>
              <textarea
                value={d.description}
                onChange={(e) => updateDraft(d.category, { description: e.target.value })}
                placeholder={placeholderDesc}
                rows={2}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border-strong)",
                  background: "var(--bg)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  resize: "vertical",
                  boxSizing: "border-box",
                  marginBottom: 10,
                }}
              />

              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Type
              </label>
              <select
                value={d.type}
                onChange={(e) => updateDraft(d.category, { type: e.target.value as SkillType })}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border-strong)",
                  background: "var(--bg)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  marginBottom: d.suggestedType && d.suggestedType !== d.type ? 6 : 10,
                }}
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {d.suggestedType && d.suggestedType !== d.type && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
                  ✦ Suggested:{" "}
                  <button
                    type="button"
                    onClick={() => updateDraft(d.category, { type: d.suggestedType! })}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      color: "var(--accent)",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                  >
                    {TYPE_OPTIONS.find((o) => o.value === d.suggestedType)?.label}
                  </button>
                </div>
              )}

              <details>
                <summary
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  {d.items.length} rule{d.items.length > 1 ? "s" : ""} included
                </summary>
                <ul
                  style={{
                    margin: "6px 0 0 0",
                    paddingLeft: 18,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  {d.items.map((c) => {
                    const url =
                      repo && c.evidence_path
                        ? repoBlobUrl(
                            repo.provider,
                            repo.full_name,
                            repo.default_branch,
                            c.evidence_path,
                            c.evidence_start_line ?? null,
                            c.evidence_end_line ?? null,
                          )
                        : null;
                    const lineLabel =
                      c.evidence_start_line != null
                        ? c.evidence_end_line && c.evidence_end_line !== c.evidence_start_line
                          ? `:${c.evidence_start_line}-${c.evidence_end_line}`
                          : `:${c.evidence_start_line}`
                        : "";
                    return (
                      <li key={c.id} style={{ marginBottom: 4 }}>
                        <div>{c.rule}</div>
                        {c.evidence_path && (
                          <div style={{ marginTop: 2 }}>
                            {url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open ${c.evidence_path} on ${repo?.provider === "bitbucket" ? "Bitbucket" : "GitHub"}`}
                                style={{
                                  fontSize: 11,
                                  fontFamily: "monospace",
                                  color: "var(--accent)",
                                  textDecoration: "none",
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
                              >
                                {c.evidence_path}{lineLabel} ↗
                              </a>
                            ) : (
                              <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-muted)" }}>
                                {c.evidence_path}{lineLabel}
                              </span>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
            </div>
          );
        })}

        <div style={{ marginTop: 16 }}>
          <label
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              display: "block",
              marginBottom: 4,
            }}
          >
            Also link to agent (optional)
          </label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              fontSize: 13,
            }}
          >
            <option value="">None</option>
            {agents?.map((a: { id: string; name: string }) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}
