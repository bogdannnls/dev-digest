import type { CSSProperties } from "react";

const GRID_COLS = "28px 160px 90px 90px 90px 110px 100px 110px";

/** Co-located styles for EvalRunsTable. No `<table>` — a CSS-grid list, the
 *  same convention every other list in this codebase uses. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  actions: { display: "flex", justifyContent: "flex-end" } satisfies CSSProperties,
  /** The columns are fixed px and total ~834px with gaps. That fits the full-width
   *  Eval Dashboard but not the agent editor's right pane (~718px), where the
   *  previous `overflow: hidden` silently CLIPPED the last three columns —
   *  Pass, Cost and Status became unreachable rather than scrollable. Scrolling
   *  on X (with `max-content` rows so they don't squash and misalign) keeps the
   *  rounded corners clipped while making every column reachable. */
  table: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    overflowX: "auto",
    overflowY: "hidden",
  } satisfies CSSProperties,
  headerRow: {
    display: "grid",
    gridTemplateColumns: GRID_COLS,
    minWidth: "max-content",
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
    minWidth: "max-content",
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
