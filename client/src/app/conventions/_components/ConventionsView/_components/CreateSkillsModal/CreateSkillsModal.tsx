"use client";

import React from "react";
import type { ConventionCandidate } from "@devdigest/shared";
import { Button, Modal } from "@devdigest/ui";
import { useToast } from "../../../../../../lib/toast";
import { useCreateSkillsFromConventions } from "../../../../../../lib/hooks/conventions";
import { useAgents } from "../../../../../../lib/hooks/agents";

interface Props {
  repoId: string;
  repoSlug: string;
  candidates: ConventionCandidate[];
  onClose: () => void;
}

interface SkillGroup {
  category: string;
  name: string;
  items: ConventionCandidate[];
}

export function CreateSkillsModal({ repoId, repoSlug, candidates, onClose }: Props) {
  const toast = useToast();
  const create = useCreateSkillsFromConventions(repoId);
  const { data: agents } = useAgents();
  const [agentId, setAgentId] = React.useState("");

  const groups = React.useMemo<SkillGroup[]>(() => {
    const map = new Map<string, ConventionCandidate[]>();
    for (const c of candidates) {
      const g = map.get(c.category) ?? [];
      g.push(c);
      map.set(c.category, g);
    }
    return [...map.entries()].map(([category, items]) => ({
      category,
      name: `${repoSlug}-${category}`,
      items,
    }));
  }, [candidates, repoSlug]);

  const handleCreate = () => {
    create.mutate(
      { agent_id: agentId || undefined },
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
      <Button kind="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
      <Button kind="primary" onClick={handleCreate} disabled={create.isPending || groups.length === 0}>
        {create.isPending ? "Creating…" : `Create ${groups.length} skill${groups.length > 1 ? "s" : ""} ✦`}
      </Button>
    </div>
  );

  return (
    <Modal
      title="Create skill from conventions"
      subtitle={`${repoSlug}-conventions`}
      onClose={onClose}
      footer={footer}
    >
      <div style={{
        marginBottom: 16, padding: "10px 14px", borderRadius: 6,
        background: "var(--bg-elevated)", border: "1px solid var(--border)",
        fontSize: 13, color: "var(--text-secondary)",
      }}>
        ✦ Merged from {candidates.length} accepted convention{candidates.length > 1 ? "s" : ""} in{" "}
        <span style={{ color: "var(--accent)" }}>{repoSlug}</span>. Everything below is editable before you save.
      </div>

      {groups.map((g) => (
        <div key={g.category} style={{
          marginBottom: 12, padding: 14, border: "1px solid var(--border)", borderRadius: 8,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>
            {g.category} · {g.items.length} convention{g.items.length > 1 ? "s" : ""}
          </div>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
            Skill name: <code>{g.name}</code>
          </p>
          <ul style={{ margin: "8px 0 0 0", paddingLeft: 16, fontSize: 12, color: "var(--text-secondary)" }}>
            {g.items.map((c) => <li key={c.id} style={{ marginBottom: 2 }}>{c.rule}</li>)}
          </ul>
        </div>
      ))}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          Also link to agent (optional)
        </label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 }}
        >
          <option value="">None</option>
          {agents?.map((a: { id: string; name: string }) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
