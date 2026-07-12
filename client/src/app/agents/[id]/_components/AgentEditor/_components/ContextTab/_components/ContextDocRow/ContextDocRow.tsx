"use client";

import React from "react";
import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { Badge, IconBtn } from "@devdigest/ui";
import { deriveContextKind } from "@/lib/context-kind";

const s = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
  } as CSSProperties,
  // AC-20: inherited docs render visually distinct from the agent's own —
  // dashed border, muted background, reduced opacity (mirrors LinkedSkillRow's
  // disabled-skill treatment, opacity 0.5, but with an added dashed border so
  // it reads as "not part of this list" rather than merely "toggled off").
  inheritedRow: {
    opacity: 0.65,
    borderStyle: "dashed",
    background: "var(--bg-hover)",
  } as CSSProperties,
  dragging: { opacity: 0.6, boxShadow: "0 6px 16px rgba(0,0,0,.18)" } as CSSProperties,
  handle: {
    cursor: "grab",
    color: "var(--text-muted)",
    display: "flex",
    alignItems: "center",
  } as CSSProperties,
  path: { flex: 1, fontFamily: "var(--mono)", fontSize: 13 } as CSSProperties,
};

export interface ContextDocRowProps {
  path: string;
  /** True for a document inherited from an enabled skill (AC-18/20/21) —
   *  read-only here: no drag handle, no remove action. */
  inherited?: boolean;
  onPreview: () => void;
  /** Absent for inherited rows — removal only applies to the agent's own list. */
  onRemove?: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
}

export function ContextDocRow({
  path,
  inherited,
  onPreview,
  onRemove,
  dragHandleProps,
  isDragging,
}: ContextDocRowProps) {
  const t = useTranslations("agents.context");
  const kind = deriveContextKind(path);

  const rowStyle: CSSProperties = {
    ...s.row,
    ...(inherited ? s.inheritedRow : {}),
    ...(isDragging ? s.dragging : {}),
  };

  return (
    <div style={rowStyle}>
      {/* AC-21: inherited rows never get a drag handle. */}
      {!inherited && (
        <span {...dragHandleProps} aria-label={t("reorderAria")} style={s.handle}>
          {/* GripVertical is not in the vendor icon registry — inline SVG,
              mirroring LinkedSkillRow. The span itself (not this icon) is the
              dnd-kit keyboard-sensor accessibility target — never aria-hidden it. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="9" cy="5" r="1" />
            <circle cx="9" cy="12" r="1" />
            <circle cx="9" cy="19" r="1" />
            <circle cx="15" cy="5" r="1" />
            <circle cx="15" cy="12" r="1" />
            <circle cx="15" cy="19" r="1" />
          </svg>
        </span>
      )}

      <span style={s.path}>{path}</span>

      <Badge mono>{kind}</Badge>

      {inherited && <Badge color="var(--text-muted)">{t("inheritedBadge")}</Badge>}

      <IconBtn icon="Eye" label={t("previewAria", { path })} onClick={onPreview} size={26} />

      {/* AC-21: no remove action on inherited rows. */}
      {!inherited && onRemove && (
        <IconBtn icon="Trash" label={t("removeAria", { path })} onClick={onRemove} size={26} danger />
      )}
    </div>
  );
}
