/* ContextPreviewDrawer — shared, read-only preview for a Project Context
   document (specs/docs/insights markdown). Consumed by three client
   surfaces: the agent Context tab, the skill's "Project context to use"
   section, and the Project Context screen — so it only takes `repoId` +
   `path`, never anything agent/skill-specific (T7/T8/T9 wire it up).

   AC-39: read-only — no edit affordance, no Toggle/Dropdown, unlike
   SkillPreviewDrawer (which this mirrors for the drawer/overlay/Markdown-body/
   Esc-to-close shell).
   AC-40: a stale/missing path renders an explicit "not found" state, never a
   blank pane.
   AC-43: the kind badge is derived from the path client-side (deriveContextKind) —
   no `kind` field is read from or added to SpecFile. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, EmptyState, IconBtn, Markdown, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { useContextFile } from "@/lib/hooks/core";
import { deriveContextKind } from "@/lib/context-kind";
import { s } from "./styles";

export function ContextPreviewDrawer({
  repoId,
  path,
  onClose,
}: {
  repoId: string;
  path: string;
  onClose: () => void;
}) {
  const t = useTranslations("context");
  const { data: file, error, isLoading } = useContextFile(repoId, path);
  const kind = deriveContextKind(path);
  const notFound = error instanceof ApiError && error.status === 404;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={path}>
        <div style={s.header}>
          <Badge>{t(`preview.kind.${kind}`)}</Badge>
          <span style={s.path}>{path}</span>
          <IconBtn icon="X" label={t("preview.closeAria")} onClick={onClose} />
        </div>
        <div style={s.body}>
          {isLoading ? (
            <>
              <Skeleton height={14} style={{ marginBottom: 10 }} />
              <Skeleton width="80%" height={14} style={{ marginBottom: 10 }} />
              <Skeleton width="60%" height={14} />
            </>
          ) : notFound ? (
            <EmptyState
              icon="File"
              title={t("preview.notFound.title")}
              body={t("preview.notFound.body")}
            />
          ) : error ? (
            <EmptyState icon="AlertTriangle" title={t("preview.loadError")} />
          ) : (
            <div style={s.markdown}>
              <Markdown>{file?.content}</Markdown>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
