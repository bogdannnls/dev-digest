import type { CSSProperties } from "react";

export const s = {
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } as CSSProperties,

  label: {
    fontSize: 12,
    color: "var(--text-muted)",
  } as CSSProperties,

  select: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border-subtle)",
  } as CSSProperties,

  empty: {
    color: "var(--text-muted)",
    fontStyle: "italic",
    margin: 0,
  } as CSSProperties,
};
