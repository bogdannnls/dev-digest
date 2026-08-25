/* ContextScreen — the Project Context screen (`/context`, AC-38/AC-44).
   Mirrors `skills/_components/SkillsListView/SkillsListView.tsx`'s
   AppShell + breadcrumb + header + filter + list + preview-drawer shape,
   scoped to the workspace's currently-active repo (`useActiveRepo`).

   Renders TWO explicitly distinct states for "nothing to show" (never one
   generic empty view):
     - AC-4: the repo has no clone on disk — detected via the `useContextFiles`
       query error being an `ApiError` with `.code === "repo_not_cloned"`.
     - AC-5: the repo is cloned but discovery found zero matching documents —
       an explicit empty array, not an error.
   A third, filter-only empty state (docs exist but the current filter
   matches none) mirrors SkillsListView's "no match" state — distinct again
   from both of the above. */
"use client";

import React from "react";
import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { Badge, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { ApiError } from "@/lib/api";
import { useContextFiles } from "@/lib/hooks/core";
import { useActiveRepo } from "@/lib/repo-context";
import { deriveContextKind } from "@/lib/context-kind";
import { ContextPreviewDrawer } from "@/components/ContextPreviewDrawer";
import { AppShell } from "@/components/app-shell";
import { filterContextFiles } from "./helpers";

const s = {
  page: { padding: "32px 40px", maxWidth: 1000, margin: "0 auto" } as CSSProperties,
  header: { marginBottom: 24 } as CSSProperties,
  h1: { fontSize: 24, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-muted)", marginTop: 6, maxWidth: 640 } as CSSProperties,
  search: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 7,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    width: 280,
    marginBottom: 20,
  } as CSSProperties,
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
    fontSize: 14,
  } as CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 6 } as CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
    color: "var(--text-primary)",
  } as CSSProperties,
  rowPath: { flex: 1, fontFamily: "var(--mono)", fontSize: 13 } as CSSProperties,
};

export function ContextScreen() {
  const t = useTranslations("context");
  const { repoId } = useActiveRepo();
  const { data, error, isLoading, isError, refetch } = useContextFiles(repoId);
  const [query, setQuery] = React.useState("");
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);

  const notCloned = error instanceof ApiError && error.code === "repo_not_cloned";
  const files = data ?? [];
  const hasDocs = files.length > 0;
  const visible = filterContextFiles(files, query);
  const filteredOut = hasDocs && visible.length === 0;

  return (
    <AppShell crumb={[{ label: t("list.breadcrumbLab") }, { label: t("list.breadcrumb") }]}>
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.h1}>{t("list.title")}</h1>
          <p style={s.subtitle}>{t("list.subtitle")}</p>
        </div>

        {isLoading && (
          <div style={s.list}>
            <Skeleton height={44} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        )}

        {!isLoading && isError && !notCloned && (
          <ErrorState body={t("list.loadError")} onRetry={() => refetch()} />
        )}

        {/* AC-4: repo not cloned. */}
        {!isLoading && notCloned && (
          <EmptyState icon="Folder" title={t("list.notClonedTitle")} body={t("list.notClonedBody")} />
        )}

        {!isLoading && !isError && (
          <>
            {hasDocs && (
              <div style={s.search}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("list.searchPlaceholder")}
                  style={s.searchInput}
                />
              </div>
            )}

            {/* AC-5: repo cloned, discovery found zero documents — distinct
                from the not-cloned state above. */}
            {!hasDocs && (
              <EmptyState icon="FileText" title={t("list.noDocsTitle")} body={t("list.noDocsBody")} />
            )}

            {filteredOut && (
              <EmptyState
                icon="Search"
                title={t("list.noMatchTitle")}
                body={t("list.noMatchBody")}
                cta={t("list.noMatchCta")}
                onCta={() => setQuery("")}
              />
            )}

            {visible.length > 0 && (
              <div style={s.list}>
                {visible.map((f) => (
                  <button key={f.path} type="button" style={s.row} onClick={() => setPreviewPath(f.path)}>
                    <span style={s.rowPath}>{f.path}</span>
                    <Badge mono>{t(`preview.kind.${deriveContextKind(f.path)}`)}</Badge>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {previewPath && repoId && (
        <ContextPreviewDrawer repoId={repoId} path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </AppShell>
  );
}
