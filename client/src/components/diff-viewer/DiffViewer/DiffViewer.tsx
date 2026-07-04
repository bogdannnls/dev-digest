/* DiffViewer — basic GitHub-style unified diff viewer. Renders real PrFile.patch
   (unified-diff text from the F1 API) as a list of collapsible FileCards.
   Optional inline comments (Files changed tab): hover a line → "+" → comment,
   posted live to GitHub; existing GitHub review comments render inline. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { FindingRecord } from "@devdigest/shared";
import type { PrFile } from "@/lib/types";
import { type DiffCommentApi } from "../comments";
import { s } from "../styles";
import { FileCard } from "../FileCard";

/** Focus target from an outer component (e.g. Smart Diff badge click). */
export type DiffFocusLine = { path: string; line: number; nonce: number };

export function DiffViewer({
  files,
  commenting,
  findings,
  focusLine,
  onFindingClick,
}: {
  files: PrFile[];
  commenting?: DiffCommentApi;
  /** Findings whose file is in `files`. FileCard filters by path. */
  findings?: FindingRecord[];
  /** When set (and its `nonce` changes), the containing FileCard force-opens
   *  and scrolls the target line into view. */
  focusLine?: DiffFocusLine | null;
  /** Inline line badge click handler — parent typically opens a drawer. */
  onFindingClick?: (findingId: string) => void;
}) {
  const t = useTranslations("shell");
  if (!files || files.length === 0) {
    return <div style={s.empty}>{t("diffViewer.noChangedFiles")}</div>;
  }
  return (
    <div style={s.list}>
      {files.map((f, i) => {
        const fileFindings = findings?.filter((fn) => fn.file === f.path) ?? [];
        const fileFocus =
          focusLine && focusLine.path === f.path ? focusLine : null;
        return (
          <FileCard
            key={i}
            file={f}
            commenting={commenting}
            findings={fileFindings}
            focusLine={fileFocus}
            onFindingClick={onFindingClick}
          />
        );
      })}
    </div>
  );
}
