"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import { Icon } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { TYPE_BADGE_BG } from "../../constants";
import { s } from "./styles";

export interface LinkedSkillRowProps {
  skill: Skill;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
}

/** Inline accessible kebab menu — vendor Dropdown renders <button> without
 *  role="menuitem", so we build a small ARIA-compliant popover here. */
function KebabMenu({ onRemove, removeLabel }: { onRemove: () => void; removeLabel: string }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        aria-label="more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "none",
          border: "none",
          padding: 4,
          cursor: "pointer",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
        }}
      >
        <Icon.MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 180,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            borderRadius: 9,
            boxShadow: "var(--shadow-modal)",
            padding: 6,
            zIndex: 40,
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              onRemove();
              setOpen(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 6,
              border: "none",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 14,
              fontWeight: 500,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <Icon.Trash size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{removeLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function LinkedSkillRow({
  skill,
  enabled,
  onToggleEnabled,
  onRemove,
  dragHandleProps,
  isDragging,
}: LinkedSkillRowProps) {
  const t = useTranslations("agents.skills");

  const rowStyle: React.CSSProperties = {
    ...s.row,
    opacity: enabled ? 1 : 0.5,
    ...(isDragging ? s.dragging : {}),
  };

  return (
    <div style={rowStyle}>
      {/* Drag handle — keyboard reordering via @dnd-kit KeyboardSensor */}
      <span
        {...dragHandleProps}
        aria-label="Reorder skill"
        style={s.handle}
      >
        {/* GripVertical is not in the vendor icon registry — inline SVG */}
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

      <input
        type="checkbox"
        aria-label={skill.name}
        checked={enabled}
        onChange={(e) => onToggleEnabled(e.target.checked)}
        style={s.checkbox}
      />

      <span style={s.name}>{skill.name}</span>

      <Badge color={TYPE_BADGE_BG[skill.type]} mono>
        {skill.type}
      </Badge>

      <KebabMenu onRemove={onRemove} removeLabel={t("removeFromAgent")} />
    </div>
  );
}
