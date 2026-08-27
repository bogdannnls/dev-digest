import type { CSSProperties } from "react";

/** Co-located styles for EvalRunComparison. */
export const s = {
  body: { padding: 20, display: "flex", flexDirection: "column", gap: 20 } satisfies CSSProperties,
  deltaRow: { display: "flex", gap: 16, flexWrap: "wrap" } satisfies CSSProperties,
  deltaTile: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 100,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  deltaLabel: { fontSize: 12, color: "var(--text-muted)", fontWeight: 600 } satisfies CSSProperties,
  deltaValue: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  promptSection: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  promptHeading: { fontSize: 14, fontWeight: 700 } satisfies CSSProperties,
  promptColumns: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 } satisfies CSSProperties,
  promptColumn: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  promptBlock: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: 10,
    maxHeight: 320,
    overflow: "auto",
    margin: 0,
  } satisfies CSSProperties,
} as const;
