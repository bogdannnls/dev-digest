import type { CSSProperties } from "react";

const GRID_COLS = "1fr 110px 90px 90px 90px 24px";

/** Co-located styles for AgentsSummaryTable. No `<table>` — the same
 *  CSS-grid list convention every other list in this codebase uses. */
export const s = {
  table: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    overflow: "hidden",
  } satisfies CSSProperties,
  headerRow: {
    display: "grid",
    gridTemplateColumns: GRID_COLS,
    gap: 8,
    padding: "8px 12px",
    background: "var(--bg-surface)",
    borderBottom: "1px solid var(--border)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: GRID_COLS,
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid var(--border)",
    fontSize: 13,
    alignItems: "center",
    cursor: "pointer",
  } satisfies CSSProperties,
  cell: { display: "flex", alignItems: "center", gap: 8, overflow: "hidden", textOverflow: "ellipsis" } satisfies CSSProperties,
  agentName: { fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis" } satisfies CSSProperties,
  metricCell: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  chevron: { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" } satisfies CSSProperties,
} as const;
