import type { CSSProperties } from "react";

export const s = {
  /* IntentCard + BlastRadiusCard side by side. `auto-fit`/`minmax` collapses
     to a single column once the row can't fit two ~420px columns (roughly
     under 900px of available width) — no @media query needed since these
     are plain inline style objects, not a stylesheet. */
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))",
    gap: 20,
  } satisfies CSSProperties,
  descriptionBox: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    fontSize: 14,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  } satisfies CSSProperties,
} as const;
