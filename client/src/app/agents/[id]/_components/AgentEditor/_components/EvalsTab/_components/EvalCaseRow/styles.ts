import type { CSSProperties } from "react";

export const s = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  main: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 } satisfies CSSProperties,
  nameLine: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } satisfies CSSProperties,
  name: { fontSize: 13, fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  metaLine: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 } satisfies CSSProperties,
  fileLine: { fontFamily: "var(--font-mono)", color: "var(--text-secondary)" } satisfies CSSProperties,
  resultPass: { color: "var(--ok)" } satisfies CSSProperties,
  resultFail: { color: "var(--crit)" } satisfies CSSProperties,
  resultNone: { color: "var(--text-muted)" } satisfies CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0 } satisfies CSSProperties,
} as const;
