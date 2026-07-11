"use client";

import React from "react";
import { SectionLabel, Button, Badge } from "@devdigest/ui";
import { DiffViewer, type DiffCommentApi } from "@/components/diff-viewer";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";
import { useSmartDiff } from "@/lib/hooks/smart-diff";
import { notify } from "@/lib/toast";
import { GroupHeader } from "./GroupHeader";
import { FindingDetailDrawer } from "../FindingDetailDrawer";
import type { FindingRecord, PrFile, Severity, SmartDiffFile, SmartDiffRole } from "@devdigest/shared";

interface DiffTabProps {
  prId: string | null;
  filesCount: number;
  files: PrFile[];
  /** Inline commenting is offered only on open PRs (GitHub rejects otherwise). */
  canComment?: boolean;
  allFindings: FindingRecord[];
  /** owner/repo + head sha — used by the finding drawer to deep-link to GitHub. */
  repoFullName?: string | null;
  headSha?: string | null;
}

/** In-diff focus target — bumping nonce re-triggers scroll for repeat clicks. */
export type DiffFocusLine = { path: string; line: number; nonce: number };

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

const SEVERITY_COLOR: Record<Severity, string> = {
  CRITICAL: "var(--crit)",
  WARNING: "var(--warn)",
  SUGGESTION: "var(--sugg)",
};
const SEVERITY_BG: Record<Severity, string> = {
  CRITICAL: "var(--crit-bg)",
  WARNING: "var(--warn-bg)",
  SUGGESTION: "var(--sugg-bg)",
};

/** One Smart Diff group: header + (when expanded) per-finding badges + files. */
function DiffGroupSection({
  group,
  collapsed,
  groupPrFiles,
  groupFindings,
  focusLine,
  commenting,
  onToggle,
  onChipClick,
  onLineBadgeClick,
}: {
  group: { role: SmartDiffRole; files: SmartDiffFile[] };
  collapsed: boolean;
  groupPrFiles: PrFile[];
  /** Findings whose file belongs to this group, sorted by file+start_line. */
  groupFindings: FindingRecord[];
  focusLine: DiffFocusLine | null;
  commenting: DiffCommentApi;
  onToggle: () => void;
  /** Header chip click → scroll to that finding's line in the diff. */
  onChipClick: (finding: FindingRecord) => void;
  /** Inline line badge click → open the drawer for that finding. */
  onLineBadgeClick: (findingId: string) => void;
}) {
  const findingCount = groupFindings.length;

  return (
    <div data-group={group.role} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <GroupHeader
        role={group.role}
        fileCount={group.files.length}
        findingCount={findingCount}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            borderLeft: "2px solid var(--border)",
            paddingLeft: 12,
            marginLeft: 4,
          }}
        >
          {groupFindings.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {groupFindings.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onChipClick(f)}
                  title={f.title}
                  aria-label={`Scroll to ${f.file}:${f.start_line}`}
                  style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}
                >
                  <Badge
                    color={SEVERITY_COLOR[f.severity]}
                    bg={SEVERITY_BG[f.severity]}
                    mono
                  >
                    {basenameOf(f.file)}:{f.start_line}
                  </Badge>
                </button>
              ))}
            </div>
          )}
          <DiffViewer
            files={groupPrFiles}
            commenting={commenting}
            findings={groupFindings}
            focusLine={focusLine}
            onFindingClick={onLineBadgeClick}
          />
        </div>
      )}
    </div>
  );
}

export function DiffTab({
  prId,
  filesCount,
  files,
  canComment,
  allFindings,
  repoFullName,
  headSha,
}: DiffTabProps) {
  const { data: comments } = usePrComments(prId);
  const create = useCreatePrComment(prId);
  // Comments start hidden so the diff is clean by default — toggle to reveal.
  const [showComments, setShowComments] = React.useState(false);

  const { data: smartDiff, isError: smartDiffError } = useSmartDiff(prId);

  const [collapsed, setCollapsed] = React.useState<Record<SmartDiffRole, boolean>>({
    core: false,
    wiring: false,
    boilerplate: true,
  });

  // Group findings by their file so each Smart Diff group can render only
  // its own badges. Sorted by (file, start_line) for stable, top-to-bottom order.
  const findingsByPath = React.useMemo(() => {
    const map = new Map<string, FindingRecord[]>();
    for (const f of allFindings) {
      const arr = map.get(f.file);
      if (arr) arr.push(f);
      else map.set(f.file, [f]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.start_line - b.start_line);
    }
    return map;
  }, [allFindings]);

  // Header chip → scroll to that finding's line inside the diff. The nonce
  // re-triggers scroll for a repeat click on the same chip (same {path,line}
  // otherwise wouldn't re-fire the effect in FileCard).
  const [focusLine, setFocusLine] = React.useState<DiffFocusLine | null>(null);
  const handleChipClick = React.useCallback((f: FindingRecord) => {
    setFocusLine((prev) => ({ path: f.file, line: f.start_line, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Inline line badge → open the finding drawer. State is DiffTab-local (no URL
  // param yet) — matches the ephemeral nature of "look at this finding" UX and
  // avoids a URL-driven remount storm on rapid clicks between findings.
  const [openFindingId, setOpenFindingId] = React.useState<string | null>(null);
  const openFinding = React.useMemo(
    () => (openFindingId ? allFindings.find((f) => f.id === openFindingId) ?? null : null),
    [openFindingId, allFindings],
  );

  const commentCount = comments?.length ?? 0;

  const commenting: DiffCommentApi = {
    comments: comments ?? [],
    canComment: !!canComment && !!prId,
    showComments,
    posting: create.isPending,
    onSubmit: async (input) => {
      try {
        const res = await create.mutateAsync(input);
        setShowComments(true); // a just-posted comment shouldn't stay hidden
        return res;
      } catch (err) {
        notify.error(err instanceof Error ? err.message : "Couldn't post the comment to GitHub.");
        throw err;
      }
    },
  };

  const filesByPath = React.useMemo(() => {
    const map = new Map<string, PrFile>();
    for (const f of files) map.set(f.path, f);
    return map;
  }, [files]);

  const hasGroups = !!smartDiff && smartDiff.groups.some((g) => g.files.length > 0);
  const useFlatView = !smartDiff || smartDiffError || !hasGroups;

  return (
    <section>
      <SectionLabel
        icon="Code"
        right={
          commentCount > 0 ? (
            <Button
              kind="ghost"
              size="sm"
              icon={showComments ? "EyeOff" : "Eye"}
              onClick={() => setShowComments((v) => !v)}
            >
              {showComments ? "Hide comments" : "Show comments"} ({commentCount})
            </Button>
          ) : undefined
        }
      >
        Files changed · {filesCount} files
      </SectionLabel>

      {useFlatView ? (
        <DiffViewer
          files={files}
          commenting={commenting}
          findings={allFindings}
          focusLine={focusLine}
          onFindingClick={setOpenFindingId}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {smartDiff.split_suggestion.too_big && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 7,
                border: "1px solid var(--warn)",
                background: "var(--warn-bg)",
                color: "var(--warn)",
                fontSize: 13,
              }}
            >
              This PR is {smartDiff.split_suggestion.total_lines} lines. Consider splitting.
            </div>
          )}

          {smartDiff.groups
            .filter((group) => group.files.length > 0)
            .map((group) => {
              const groupPrFiles = group.files
                .map((sf: SmartDiffFile) => filesByPath.get(sf.path))
                .filter((f): f is PrFile => !!f);
              const groupFindings = group.files.flatMap(
                (sf) => findingsByPath.get(sf.path) ?? [],
              );

              return (
                <DiffGroupSection
                  key={group.role}
                  group={group}
                  collapsed={collapsed[group.role]}
                  groupPrFiles={groupPrFiles}
                  groupFindings={groupFindings}
                  focusLine={focusLine}
                  commenting={commenting}
                  onToggle={() => setCollapsed((prev) => ({ ...prev, [group.role]: !prev[group.role] }))}
                  onChipClick={handleChipClick}
                  onLineBadgeClick={setOpenFindingId}
                />
              );
            })}
        </div>
      )}

      {openFinding && prId && (
        <FindingDetailDrawer
          finding={openFinding}
          prId={prId}
          repoFullName={repoFullName}
          headSha={headSha}
          onClose={() => setOpenFindingId(null)}
        />
      )}
    </section>
  );
}
