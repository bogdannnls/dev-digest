import type { CSSProperties } from "react";

/** Co-located styles for EvalAgentDashboardView. */
export const s = {
  page: { padding: "24px 32px 44px", maxWidth: 1200, margin: "0 auto" } satisfies CSSProperties,
  loadingStack: { display: "flex", flexDirection: "column", gap: 16 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 } satisfies CSSProperties,
  headerIcon: { color: "var(--accent)" } satisfies CSSProperties,
  h1: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  headerActions: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 } satisfies CSSProperties,
  alertBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    background: "var(--warn-bg)",
    color: "var(--warn)",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 20,
  } satisfies CSSProperties,
  section: { marginBottom: 28 } satisfies CSSProperties,
  h2: { fontSize: 14, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 12 } satisfies CSSProperties,
} as const;
