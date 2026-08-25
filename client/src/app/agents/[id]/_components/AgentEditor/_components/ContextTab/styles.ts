import type { CSSProperties } from "react";

export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 14 } as CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12 } as CSSProperties,
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  hint: { fontSize: 12, color: "var(--text-muted)" } as CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 6 } as CSSProperties,
  empty: {
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: "32px 16px",
    textAlign: "center",
  } as CSSProperties,
  emptyTitle: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 } as CSSProperties,
  emptyBody: { fontSize: 13, color: "var(--text-muted)", marginBottom: 14 } as CSSProperties,
  inheritedLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
    marginTop: 8,
  } as CSSProperties,
};
