/* FileCard — one collapsible file in the diff: header (path, +/- stat, comment
   count) and, when open, its parsed lines plus any outdated comments. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import type { PrFile } from "@/lib/types";
import { AUTO_EXPAND_MAX_LINES } from "../constants";
import { parsePatch, type Line } from "../helpers";
import {
  buildThreads,
  keysForLine,
  partitionThreads,
  type CommentThread,
  type DiffCommentApi,
} from "../comments";
import { s, chevronFor } from "../styles";
import { CodeLine } from "../CodeLine";
import { OutdatedComments } from "../OutdatedComments";

/** Threads anchored to a given parsed line (RIGHT=new, LEFT=old). */
function threadsForLine(ln: Line, matched: Map<string, CommentThread[]>): CommentThread[] {
  if (matched.size === 0) return [];
  const out: CommentThread[] = [];
  for (const key of keysForLine(ln)) {
    const list = matched.get(key);
    if (list) out.push(...list);
  }
  return out;
}

export function FileCard({
  file,
  commenting,
  findings,
  focusLine,
  onFindingClick,
}: {
  file: PrFile;
  commenting?: DiffCommentApi;
  /** Findings anchored to this file — used to render inline severity badges. */
  findings?: FindingRecord[];
  /** When set (matched by path) the card force-opens and scrolls to the line. */
  focusLine?: { path: string; line: number; nonce: number } | null;
  onFindingClick?: (findingId: string) => void;
}) {
  const t = useTranslations("shell");
  const [open, setOpen] = React.useState(
    (file.additions ?? 0) + (file.deletions ?? 0) <= AUTO_EXPAND_MAX_LINES
  );
  const lines = React.useMemo(() => parsePatch(file.patch), [file.patch]);

  // Map new-line number → first matching finding, for inline badges. `start_line`
  // is the new-side line (post-change). Uses `newNo` since diff-viewer keys.
  const findingByNewLine = React.useMemo(() => {
    const map = new Map<number, FindingRecord>();
    for (const f of findings ?? []) {
      if (!map.has(f.start_line)) map.set(f.start_line, f);
    }
    return map;
  }, [findings]);

  // Focus-driven scroll: when focusLine.nonce changes (parent bumped it), open
  // this card if closed, then scroll to the CodeLine whose newNo matches. Refs
  // are collected below as each line renders.
  const lineRefs = React.useRef(new Map<number, HTMLDivElement>());
  React.useEffect(() => {
    if (!focusLine) return;
    setOpen(true);
    // Wait one frame so the just-opened body is in the DOM before scrolling.
    const rafId = requestAnimationFrame(() => {
      lineRefs.current.get(focusLine.line)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(rafId);
  }, [focusLine?.nonce, focusLine?.line]);

  // Group this file's comments into threads, then split into ones we can anchor
  // to a rendered line vs. "outdated" (GitHub dropped the line / it's not here).
  const comments = commenting?.comments;
  const { matched, outdated } = React.useMemo(() => {
    if (!comments) return { matched: new Map<string, CommentThread[]>(), outdated: [] };
    const fileThreads = buildThreads(comments.filter((c) => c.path === file.path));
    const renderedKeys = new Set<string>();
    for (const ln of lines) for (const k of keysForLine(ln)) renderedKeys.add(k);
    return partitionThreads(fileThreads, renderedKeys);
  }, [comments, file.path, lines]);

  const commentCount = commenting
    ? commenting.comments.filter((c) => c.path === file.path).length
    : 0;

  return (
    <div style={s.fileCard}>
      <div onClick={() => setOpen((o) => !o)} style={s.fileHeader}>
        <Icon.ChevronRight size={13} style={chevronFor(open)} />
        <Icon.FileText size={14} style={s.fileIcon} />
        <span className="mono" style={s.filePath}>
          {file.path}
        </span>
        <span className="mono tnum" style={s.fileStat}>
          <span style={s.addText}>+{file.additions}</span>{" "}
          <span style={s.delText}>−{file.deletions}</span>
        </span>
        {commentCount > 0 && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}
          >
            <Icon.MessageSquare size={12} />
            {commentCount}
          </span>
        )}
      </div>
      {open && (
        <div style={s.fileBody}>
          {lines.length === 0 ? (
            <div style={s.noDiff}>{t("diffViewer.noDiffText")}</div>
          ) : (
            lines.map((ln, i) => {
              const finding = ln.newNo != null ? findingByNewLine.get(ln.newNo) ?? null : null;
              return (
                <CodeLine
                  key={i}
                  ln={ln}
                  path={file.path}
                  threads={threadsForLine(ln, matched)}
                  commenting={commenting}
                  finding={finding}
                  onFindingClick={onFindingClick}
                  registerRef={(el) => {
                    if (ln.newNo == null) return;
                    if (el) lineRefs.current.set(ln.newNo, el);
                    else lineRefs.current.delete(ln.newNo);
                  }}
                />
              );
            })
          )}
          {commenting && commenting.showComments && <OutdatedComments threads={outdated} />}
        </div>
      )}
    </div>
  );
}
