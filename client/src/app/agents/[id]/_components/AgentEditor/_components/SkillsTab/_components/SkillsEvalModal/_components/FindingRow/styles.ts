import type { CSSProperties } from "react";

export const s = {
  row: {
    display: "grid",
    gridTemplateColumns: "10px 1fr auto",
    gap: 8,
    alignItems: "center",
    padding: "6px 0",
    borderBottom: "1px solid var(--border)",
  } as CSSProperties,
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  } as CSSProperties,
  fileLine: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  } as CSSProperties,
  title: {
    fontSize: 13,
    flex: 1,
  } as CSSProperties,
  badge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.5px",
    padding: "2px 6px",
    borderRadius: 4,
    border: "1px solid currentColor",
    whiteSpace: "nowrap" as const,
  } as CSSProperties,
};
