import type { CSSProperties } from "react";

export const s = {
  page: { padding: "32px 40px", maxWidth: 1400, margin: "0 auto" } as CSSProperties,
  header: { display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 24 } as CSSProperties,
  headerText: { flex: 1 } as CSSProperties,
  h1: { fontSize: 24, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-muted)", marginTop: 6 } as CSSProperties,
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
  searchIcon: { color: "var(--text-muted)" } as CSSProperties,
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
    fontSize: 14,
  } as CSSProperties,
  toolbarRow: { display: "flex", gap: 12, alignItems: "center", marginBottom: 20 } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 16,
  } as CSSProperties,
};
