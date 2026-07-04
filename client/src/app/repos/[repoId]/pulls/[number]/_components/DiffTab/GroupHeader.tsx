/* GroupHeader — collapsible header row for one Smart Diff group (core/wiring/
   boilerplate). Mirrors the chevron/toggle pattern used by diff-viewer's
   FileCard (rotate-on-open), but implemented as a real <button> so it's
   keyboard-accessible for free (no manual Enter/Space handling needed). */
"use client";

import React from "react";
import { Icon } from "@devdigest/ui";
import type { SmartDiffRole } from "@devdigest/shared";

const ROLE_LABEL: Record<SmartDiffRole, string> = {
  core: "Core",
  wiring: "Wiring",
  boilerplate: "Boilerplate",
};

export interface GroupHeaderProps {
  role: SmartDiffRole;
  fileCount: number;
  findingCount: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function GroupHeader({ role, fileCount, findingCount, collapsed, onToggle }: GroupHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-elevated)",
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
      }}
    >
      <Icon.ChevronRight
        size={13}
        style={{
          color: "var(--text-muted)",
          transform: collapsed ? "none" : "rotate(90deg)",
          transition: "transform .12s",
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
        {ROLE_LABEL[role]}
      </span>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        · {fileCount} {fileCount === 1 ? "file" : "files"}
      </span>
      {findingCount > 0 && (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          · {findingCount} {findingCount === 1 ? "finding" : "findings"}
        </span>
      )}
    </button>
  );
}
