import type { CSSProperties } from "react";

export const s = {
  body: {
    minHeight: 200,
    padding: 24,
  } as CSSProperties,

  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  } as CSSProperties,

  runningBox: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: 24,
    color: "var(--text-muted)",
  } as CSSProperties,

  errorBox: {
    padding: 16,
    color: "var(--text-danger)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  } as CSSProperties,
};
