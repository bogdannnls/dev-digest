"use client";

import React from "react";
import { SectionLabel, Button, Badge } from "@devdigest/ui";
import { DiffViewer, type DiffCommentApi } from "@/components/diff-viewer";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";
import { useSmartDiff } from "@/lib/hooks/smart-diff";
import { notify } from "@/lib/toast";
import { GroupHeader } from "./GroupHeader";
import type { FindingRecord, PrFile, Severity, SmartDiffFile, SmartDiffRole } from "@devdigest/shared";

interface DiffTabProps {
  prId: string | null;
  filesCount: number;
  files: PrFile[];
  /** Inline commenting is offered only on open PRs (GitHub rejects otherwise). */
  canComment?: boolean;
  allFindings: FindingRecord[];
}

// CRITICAL > WARNING > SUGGESTION — index used as a "higher is worse" rank.
const SEVERITY_RANK: Record<Severity, number> = { SUGGESTION: 0, WARNING: 1, CRITICAL: 2 };

/** Highest severity per file path, derived from every finding across all runs. */
function computeSeverityByFile(allFindings: FindingRecord[]): Map<string, Severity> {
  const map = new Map<string, Severity>();
  for (const f of allFindings) {
    const current = map.get(f.file);
    if (!current || SEVERITY_RANK[f.severity] > SEVERITY_RANK[current]) {
      map.set(f.file, f.severity);
    }
  }
  return map;
}

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

/** One Smart Diff group: header + (when expanded) finding badges + files. */
function DiffGroupSection({
  group,
  collapsed,
  groupPrFiles,
  severityByFile,
  commenting,
  onToggle,
  onBadgeClick,
  registerRef,
}: {
  group: { role: SmartDiffRole; files: SmartDiffFile[] };
  collapsed: boolean;
  groupPrFiles: PrFile[];
  severityByFile: Map<string, Severity>;
  commenting: DiffCommentApi;
  onToggle: () => void;
  onBadgeClick: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const findingCount = group.files.reduce((sum, f) => sum + f.finding_lines.length, 0);
  const filesWithFindings = group.files.filter((sf) => sf.finding_lines.length > 0);

  return (
    <div data-group={group.role} ref={registerRef} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <GroupHeader
        role={group.role}
        fileCount={group.files.length}
        findingCount={findingCount}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <>
          {filesWithFindings.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {filesWithFindings.map((sf) => {
                const severity = severityByFile.get(sf.path);
                return (
                  <button
                    key={sf.path}
                    type="button"
                    onClick={onBadgeClick}
                    style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}
                  >
                    <Badge
                      color={severity ? SEVERITY_COLOR[severity] : undefined}
                      bg={severity ? SEVERITY_BG[severity] : undefined}
                      mono
                    >
                      {basenameOf(sf.path)} · {sf.finding_lines.length}{" "}
                      {sf.finding_lines.length === 1 ? "finding" : "findings"}
                    </Badge>
                  </button>
                );
              })}
            </div>
          )}
          <DiffViewer files={groupPrFiles} commenting={commenting} />
        </>
      )}
    </div>
  );
}

export function DiffTab({ prId, filesCount, files, canComment, allFindings }: DiffTabProps) {
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

  // Pragmatic simplification (see task note): DiffViewer renders per-file cards
  // internally and doesn't expose a per-file DOM anchor, so badge clicks scroll
  // to the group's outer wrapper rather than the individual file card. Anchors
  // are collected via ref callbacks into a plain Map (no state — DOM refs don't
  // need to trigger re-renders).
  const groupRefs = React.useRef(new Map<SmartDiffRole, HTMLDivElement>());
  // A badge click on a collapsed group must expand it AND scroll to it. Expanding
  // is a state update (re-render), so the scroll has to happen in an effect that
  // runs after that re-render commits — not synchronously in the click handler,
  // where the target might not be in the DOM yet (or might be about to move).
  const [pendingScrollRole, setPendingScrollRole] = React.useState<SmartDiffRole | null>(null);

  React.useEffect(() => {
    if (!pendingScrollRole) return;
    groupRefs.current.get(pendingScrollRole)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingScrollRole(null);
  }, [pendingScrollRole, collapsed]);

  const severityByFile = React.useMemo(() => computeSeverityByFile(allFindings), [allFindings]);

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

  const handleBadgeClick = (role: SmartDiffRole) => {
    if (collapsed[role]) {
      setCollapsed((prev) => ({ ...prev, [role]: false }));
    }
    setPendingScrollRole(role);
  };

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
        <DiffViewer files={files} commenting={commenting} />
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

              return (
                <DiffGroupSection
                  key={group.role}
                  group={group}
                  collapsed={collapsed[group.role]}
                  groupPrFiles={groupPrFiles}
                  severityByFile={severityByFile}
                  commenting={commenting}
                  onToggle={() => setCollapsed((prev) => ({ ...prev, [group.role]: !prev[group.role] }))}
                  onBadgeClick={() => handleBadgeClick(group.role)}
                  registerRef={(el) => {
                    if (el) groupRefs.current.set(group.role, el);
                    else groupRefs.current.delete(group.role);
                  }}
                />
              );
            })}
        </div>
      )}
    </section>
  );
}
