import type { CSSProperties } from "react";

export const s = {
  page: { padding: "32px 40px", maxWidth: 960, margin: "0 auto" } as CSSProperties,
  h1: { fontSize: 22, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-muted)", marginTop: 6, marginBottom: 24 } as CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 12, marginTop: 24 } as CSSProperties,
  savedNote: { fontSize: 12, color: "var(--text-muted)" } as CSSProperties,
};
