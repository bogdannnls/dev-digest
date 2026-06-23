import type { CSSProperties } from "react";

export const s = {
  split: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  } as CSSProperties,

  column: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 12,
    minHeight: 200,
    display: "flex",
    flexDirection: "column",
  } as CSSProperties,

  header: {
    borderBottom: "1px solid var(--border)",
    paddingBottom: 8,
    marginBottom: 8,
  } as CSSProperties,

  heading: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
  } as CSSProperties,

  meta: {
    display: "flex",
    gap: 12,
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 4,
  } as CSSProperties,

  body: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
  } as CSSProperties,

  empty: {
    color: "var(--text-muted)",
    fontSize: 13,
    padding: "16px 0",
    margin: 0,
  } as CSSProperties,
};
