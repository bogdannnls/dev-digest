import type { CSSProperties } from "react";

export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 14 } as CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12 } as CSSProperties,
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  pill: {
    fontSize: 12,
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "2px 8px",
  } as CSSProperties,
  filter: {
    flex: 1,
    maxWidth: 320,
    height: 30,
    padding: "0 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontSize: 13,
  } as CSSProperties,
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
};
