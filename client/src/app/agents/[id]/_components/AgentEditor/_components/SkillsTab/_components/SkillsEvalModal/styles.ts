import type { CSSProperties } from "react";

export const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "grid",
    placeItems: "center",
    zIndex: 1000,
  } as CSSProperties,

  dialog: {
    background: "var(--bg-card)",
    borderRadius: 12,
    padding: 20,
    width: "min(900px, 90vw)",
    maxHeight: "90vh",
    overflow: "auto",
  } as CSSProperties,

  header: {
    marginBottom: 16,
  } as CSSProperties,

  body: {
    minHeight: 200,
  } as CSSProperties,

  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 16,
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
