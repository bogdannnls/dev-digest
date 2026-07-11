import type { CSSProperties } from "react";

/** Co-located styles for ActiveRunsStack. Kept in inline-styles idiom to
 *  match the toast module's convention (no Tailwind classes on this feature). */
export const s = {
  stack: {
    position: "fixed",
    bottom: 20,
    right: 20,
    zIndex: 999, // one below toast (1000) — toasts win the rare overlap
    display: "flex",
    flexDirection: "column-reverse", // newest cards appear at the bottom
    gap: 8,
    pointerEvents: "none", // gaps don't block clicks; cards re-enable below
    maxHeight: "60vh",
    overflowY: "auto",
  } satisfies CSSProperties,

  card: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 9,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    color: "var(--text-primary)",
    boxShadow: "0 6px 24px rgba(0,0,0,0.3)",
    textDecoration: "none",
    minWidth: 240,
    maxWidth: 320,
    animation: "ddActiveRunIn .2s ease-out",
    cursor: "pointer",
  } satisfies CSSProperties,

  cardExiting: {
    animation: "ddActiveRunOut .18s ease-in forwards",
  } satisfies CSSProperties,

  spinnerWrap: {
    position: "relative",
    width: 18,
    height: 18,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  } satisfies CSSProperties,

  pulseHalo: {
    position: "absolute",
    inset: 2,
    borderRadius: "50%",
    animation: "ddActiveRunPulse 1.4s ease-out infinite",
  } satisfies CSSProperties,

  spinner: {
    animation: "ddActiveRunSpin 1s linear infinite",
    display: "block",
  } satisfies CSSProperties,

  body: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    flex: 1,
  } satisfies CSSProperties,

  title: {
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.25,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies CSSProperties,

  sub: {
    fontSize: 11.5,
    color: "var(--text-muted)",
    lineHeight: 1.3,
  } satisfies CSSProperties,
} as const;
