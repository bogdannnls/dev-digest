import type { CSSProperties } from "react";
import type { SkillType } from "@devdigest/shared";
import { TYPE_BADGE_BG } from "../../constants";

export const s = {
  card: (enabled: boolean): CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 16,
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
    cursor: "pointer",
    opacity: enabled ? 1 : 0.55,
    transition: "background .12s, border-color .12s",
    textAlign: "left",
    color: "var(--text-primary)",
    font: "inherit",
  }),
  headerRow: { display: "flex", alignItems: "center", gap: 10 } as CSSProperties,
  name: {
    flex: 1,
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--text-primary)",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as CSSProperties,
  description: {
    fontSize: 13,
    color: "var(--text-muted)",
    lineHeight: 1.5,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  } as CSSProperties,
  badge: (type: SkillType): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    color: "var(--text-inverse)",
    background: TYPE_BADGE_BG[type],
    textTransform: "lowercase",
    letterSpacing: ".02em",
  }),
};
