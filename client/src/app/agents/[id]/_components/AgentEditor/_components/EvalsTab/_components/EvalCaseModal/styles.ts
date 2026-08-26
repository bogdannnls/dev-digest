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
  /** Two rows, not one. The line-number fields are `<input type="number">`,
   *  whose min-content width in Chrome is ~168px once the spinner is counted —
   *  in a 90px track the grid item could not shrink to fit (grid items default
   *  to `min-width: auto`) and pushed the whole modal ~80px wider than its own
   *  body, which is what produced the horizontal scrollbar. The input lives in
   *  `vendor/ui`, so it cannot be given `min-width: 0` directly; giving the
   *  fields a track wider than their intrinsic minimum solves it from here.
   *  `minmax(0, …)` keeps the tracks shrinkable if the modal ever narrows. */
  expectationGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)",
    gap: 8,
  } satisfies CSSProperties,
  lineGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: 8,
    marginTop: 8,
  } satisfies CSSProperties,
  lineLabel: {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-secondary)",
    marginBottom: 4,
  } satisfies CSSProperties,
  error: { color: "var(--crit)", fontSize: 12, marginTop: 6 } satisfies CSSProperties,
} as const;
