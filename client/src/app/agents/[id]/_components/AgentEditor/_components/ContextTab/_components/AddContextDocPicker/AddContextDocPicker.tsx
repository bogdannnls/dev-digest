"use client";

import React from "react";
import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import { useContextFiles } from "@/lib/hooks/core";
import { deriveContextKind } from "@/lib/context-kind";

const s = {
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
    alignItems: "flex-start",
    gap: 12,
  } as CSSProperties,
  titleCol: { flex: 1, display: "flex", flexDirection: "column", gap: 4 } as CSSProperties,
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 12, color: "var(--text-muted)" } as CSSProperties,
  searchWrap: {
    padding: "12px 20px",
    borderBottom: "1px solid var(--border)",
  } as CSSProperties,
  search: {
    width: "100%",
    height: 32,
    padding: "0 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontSize: 13,
  } as CSSProperties,
  list: {
    flex: 1,
    overflow: "auto",
    padding: "8px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } as CSSProperties,
  empty: {
    padding: "24px 12px",
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: 13,
  } as CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    color: "var(--text-primary)",
  } as CSSProperties,
  rowName: { flex: 1, fontFamily: "var(--mono)", fontSize: 13 } as CSSProperties,
};

export interface AddContextDocPickerProps {
  /** The workspace's currently-active repo selection (AC-12b) — the picker
   *  sources rows from this repo's discovered documents, never an
   *  agent/skill-bound repo. */
  repoId: string;
  attachedPaths: ReadonlySet<string>;
  onPick: (path: string) => void;
  onClose: () => void;
}

export function AddContextDocPicker({ repoId, attachedPaths, onPick, onClose }: AddContextDocPickerProps) {
  const t = useTranslations("agents.context.picker");
  const { data: files = [] } = useContextFiles(repoId);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = files.filter(
    (f) => !attachedPaths.has(f.path) && f.path.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={t("title")}>
        <div style={s.header}>
          <div style={s.titleCol}>
            <span style={s.title}>{t("title")}</span>
            <span style={s.subtitle}>{t("subtitle")}</span>
          </div>
          <button
            aria-label="close picker"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              padding: 4,
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
          >
            <Icon.X size={16} />
          </button>
        </div>
        <div style={s.searchWrap}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchPlaceholder")}
            style={s.search}
          />
        </div>
        <div style={s.list}>
          {filtered.length === 0 ? (
            <div style={s.empty}>{t("noUnattached")}</div>
          ) : (
            filtered.map((f) => (
              <button
                key={f.path}
                type="button"
                style={s.row}
                onClick={() => {
                  onPick(f.path);
                  onClose();
                }}
              >
                <span style={s.rowName}>{f.path}</span>
                <Badge mono>{deriveContextKind(f.path)}</Badge>
              </button>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
