import type { CSSProperties } from "react";

/** Co-located styles for BlastTab (extracted from inline styles). */
export const s = {
  degradedBadge: {
    marginBottom: 14,
  } satisfies CSSProperties,
  symbolList: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } satisfies CSSProperties,
  symbolBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 16,
    border: "1px solid var(--border, #e5e7eb)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,
  symbolHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  symbolName: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  symbolMeta: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  columnLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  callerList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    margin: 0,
    padding: 0,
    listStyle: "none",
  } satisfies CSSProperties,
  callerItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  callerName: {
    fontWeight: 500,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  noCallers: {
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  } satisfies CSSProperties,
} as const;
