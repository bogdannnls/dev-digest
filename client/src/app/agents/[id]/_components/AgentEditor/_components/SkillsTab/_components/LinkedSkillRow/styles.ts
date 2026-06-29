import type { CSSProperties } from "react";

export const s = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
  } as CSSProperties,
  dragging: { opacity: 0.6, boxShadow: "0 6px 16px rgba(0,0,0,.18)" } as CSSProperties,
  handle: {
    cursor: "grab",
    color: "var(--text-muted)",
    display: "flex",
    alignItems: "center",
  } as CSSProperties,
  checkbox: { width: 14, height: 14 } as CSSProperties,
  name: { flex: 1, fontFamily: "var(--mono)", fontSize: 13 } as CSSProperties,
};
