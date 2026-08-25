import type { CSSProperties } from "react";

/** Co-located styles for EvalTrendChart. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  legend: { display: "flex", gap: 14, fontSize: 12, color: "var(--text-secondary)" } satisfies CSSProperties,
  legendItem: { display: "flex", alignItems: "center", gap: 6 } satisfies CSSProperties,
  dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" } satisfies CSSProperties,
  empty: {
    padding: 20,
    textAlign: "center",
    color: "var(--text-secondary)",
    fontSize: 13,
    border: "1px dashed var(--border)",
    borderRadius: 8,
  } satisfies CSSProperties,
} as const;
