import type { CSSProperties } from "react";

export const s = {
  body: { display: "flex", flexDirection: "column", gap: 4 } satisfies CSSProperties,
  footer: { display: "flex", alignItems: "center", gap: 8, width: "100%" } satisfies CSSProperties,
  footerSpacer: { flex: 1 } satisfies CSSProperties,
  lastRunPass: {
    border: "1px solid var(--ok)",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 12,
    color: "var(--ok)",
    fontSize: 13,
  } satisfies CSSProperties,
  lastRunFail: {
    border: "1px solid var(--crit)",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 12,
    color: "var(--crit)",
    fontSize: 13,
  } satisfies CSSProperties,
  lastRunSummary: { color: "var(--text-secondary)", fontSize: 12, marginTop: 2 } satisfies CSSProperties,
  diffSection: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 } satisfies CSSProperties,
  previewLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" } satisfies CSSProperties,
  previewBox: {
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-elevated)",
    maxHeight: 200,
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
  } satisfies CSSProperties,
  previewLine: {
    add: { padding: "0 8px", background: "var(--ok-bg)", color: "var(--ok)" } as CSSProperties,
    del: { padding: "0 8px", background: "var(--crit-bg)", color: "var(--crit)" } as CSSProperties,
    hunk: { padding: "0 8px", color: "var(--text-muted)" } as CSSProperties,
    context: { padding: "0 8px", color: "var(--text-secondary)" } as CSSProperties,
  },
  expectationGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 2fr 90px 90px",
    gap: 8,
  } satisfies CSSProperties,
  error: { color: "var(--crit)", fontSize: 12, marginTop: 6 } satisfies CSSProperties,
} as const;
