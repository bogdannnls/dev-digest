import type { CSSProperties } from "react";

export const s = {
  row: { display: "flex", gap: 12, alignItems: "center", marginBottom: 20 } as CSSProperties,
  search: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 7,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    width: 280,
  } as CSSProperties,
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
    fontSize: 14,
  } as CSSProperties,
  chips: { display: "flex", gap: 6 } as CSSProperties,
  chip: (active: boolean): CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 99,
    fontSize: 12,
    border: "1px solid var(--border-strong)",
    background: active ? "var(--accent)" : "var(--bg-elevated)",
    color: active ? "var(--text-inverse)" : "var(--text-secondary)",
    cursor: "pointer",
  }),
  spacer: { flex: 1 } as CSSProperties,
};
