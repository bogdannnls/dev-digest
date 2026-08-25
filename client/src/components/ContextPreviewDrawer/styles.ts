import type { CSSProperties } from "react";

export const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.32)",
    zIndex: 40,
  } as CSSProperties,
  drawer: {
    position: "fixed",
    right: 0,
    top: 0,
    bottom: 0,
    width: 480,
    maxWidth: "100vw",
    background: "var(--bg-surface)",
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    zIndex: 41,
  } as CSSProperties,
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  } as CSSProperties,
  path: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--text-primary)",
  } as CSSProperties,
  body: {
    flex: 1,
    overflow: "auto",
    padding: "20px",
  } as CSSProperties,
  markdown: {
    fontSize: 13,
    color: "var(--text-primary)",
    lineHeight: 1.6,
  } as CSSProperties,
};
