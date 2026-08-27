import type { CSSProperties } from "react";

/** Co-located styles for EvalsTab. */
export const s = {
  trendUnplottable: {
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: "24px 12px",
    textAlign: "center",
    color: "var(--text-secondary)",
    fontSize: 13,
  } satisfies CSSProperties,
  wrap: { display: "flex", flexDirection: "column", gap: 24, maxWidth: 960 } satisfies CSSProperties,
  metricsHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 4,
  } satisfies CSSProperties,
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 } satisfies CSSProperties,
  subtitle: { fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" } satisfies CSSProperties,
  dashboardLink: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--accent)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  } satisfies CSSProperties,
  sectionHeader: { display: "flex", alignItems: "center", gap: 10 } satisfies CSSProperties,
  sectionTitle: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)", flex: 1, margin: 0 } satisfies CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 6 } satisfies CSSProperties,
  empty: {
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: "24px 16px",
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: 13,
  } satisfies CSSProperties,
  loading: { display: "flex", flexDirection: "column", gap: 6 } satisfies CSSProperties,
} as const;
