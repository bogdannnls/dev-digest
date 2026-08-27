import type { CSSProperties } from "react";

/** Co-located styles for EvalDashboardView. */
export const s = {
  page: { padding: "24px 32px 44px", maxWidth: 1200, margin: "0 auto" } satisfies CSSProperties,
  header: { marginBottom: 24 } satisfies CSSProperties,
  h1: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  subtitle: { fontSize: 14, color: "var(--text-secondary)", marginTop: 4 } satisfies CSSProperties,
  loadingStack: { display: "flex", flexDirection: "column", gap: 16 } satisfies CSSProperties,
  section: { marginBottom: 28 } satisfies CSSProperties,
  h2: { fontSize: 14, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 12 } satisfies CSSProperties,
} as const;
