import type { CSSProperties } from "react";

const GRID_COLS = "28px 160px 90px 90px 90px 110px 100px 110px";

/** Co-located styles for EvalRunsTable. No `<table>` — a CSS-grid list, the
 *  same convention every other list in this codebase uses. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  actions: { display: "flex", justifyContent: "flex-end" } satisfies CSSProperties,
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
  } satisfies CSSProperties,
  cell: { display: "flex", alignItems: "center", overflow: "hidden", textOverflow: "ellipsis" } satisfies CSSProperties,
  checkbox: { width: 14, height: 14 } satisfies CSSProperties,
  empty: { padding: "20px 12px", color: "var(--text-secondary)", fontSize: 13, textAlign: "center" } satisfies CSSProperties,
} as const;
