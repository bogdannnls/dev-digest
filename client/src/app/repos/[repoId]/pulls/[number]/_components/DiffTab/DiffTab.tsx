"use client";

import React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
  commenting,
  onToggle,
  onFindingClick,
}: {
  group: { role: SmartDiffRole; files: SmartDiffFile[] };
  collapsed: boolean;
  groupPrFiles: PrFile[];
  /** Findings whose file belongs to this group, sorted by file+start_line. */
  groupFindings: FindingRecord[];
  commenting: DiffCommentApi;
  onToggle: () => void;
  onFindingClick: (findingId: string) => void;
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
                  onClick={() => onFindingClick(f.id)}
                  title={f.title}
                  aria-label={`Open finding ${f.title} at ${f.file}:${f.start_line}`}
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
          <DiffViewer files={groupPrFiles} commenting={commenting} />
        </div>
      )}
    </div>
  );
}

export function DiffTab({ prId, filesCount, files, canComment, allFindings }: DiffTabProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams<{ repoId: string; number: string }>();

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

  // Badge click → soft-navigate to Findings tab focused on this finding.
  // router.replace keeps the entry out of history (no "back" back into diff-with-focus).
  const handleFindingClick = React.useCallback(
    (findingId: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("tab", "findings");
      sp.set("findingId", findingId);
      router.replace(`/repos/${params.repoId}/pulls/${params.number}?${sp.toString()}`);
    },
    [router, searchParams, params.repoId, params.number],
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
                  commenting={commenting}
                  onToggle={() => setCollapsed((prev) => ({ ...prev, [group.role]: !prev[group.role] }))}
                  onFindingClick={handleFindingClick}
                />
              );
            })}
        </div>
      )}
    </section>
  );
}
