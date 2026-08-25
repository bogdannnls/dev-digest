/* FindingsPanel — hide-low-confidence + j/k navigation + FindingCard list,
   wiring the accept/dismiss action hook (A2). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Toggle, EmptyState } from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import { FindingCard } from "../FindingCard";
import { useFindingAction } from "../../../../../../../lib/hooks/reviews";
import { useCreateEvalCaseFromFinding } from "../../../../../../../lib/hooks/eval";
import { useToast } from "../../../../../../../lib/toast";
import { ApiError } from "../../../../../../../lib/api";
import { KEY_TO_ACTION } from "./constants";
import { visibleFindings } from "./helpers";
import { s } from "./styles";

export function FindingsPanel({
  findings,
  prId,
  repoFullName,
  headSha,
  severityFilter,
}: {
  findings: FindingRecord[];
  prId: string;
  repoFullName?: string | null;
  headSha?: string | null;
  /** When set, only findings with this severity are shown (driven by ?severity= URL param). */
  severityFilter?: "CRITICAL" | "WARNING" | "SUGGESTION" | null;
}) {
  const t = useTranslations("prReview");
  const action = useFindingAction();
  const createEvalCase = useCreateEvalCaseFromFinding();
  const toast = useToast();
  const [hideLow, setHideLow] = React.useState(false);
  const [focusIdx, setFocusIdx] = React.useState(0);

  // "Turn into eval case" — a separate mutation from accept/dismiss (§5.6):
  // it derives its expectation kind from the finding's existing decision
  // rather than being a decision itself, so it is never routed through
  // `useFindingAction`/`onAction`. Surfaces the server's outcome via the
  // existing toast mechanism, including the 422 a finding whose file has no
  // stored patch produces.
  const handleCreateEvalCase = React.useCallback(
    (findingId: string) => {
      createEvalCase.mutate(findingId, {
        onSuccess: () => toast.success(t("finding.evalCaseCreated")),
        onError: (err) => {
          toast.error(err instanceof ApiError ? err.message : t("finding.evalCaseError"));
        },
      });
    },
    [createEvalCase, toast, t],
  );

  const filtered = React.useMemo(
    () => (severityFilter ? findings.filter((f) => f.severity === severityFilter) : findings),
    [findings, severityFilter],
  );
  const shown = React.useMemo(() => visibleFindings(filtered, hideLow), [filtered, hideLow]);

  // j/k navigation + a/d shortcuts on the focused finding (keyboard).
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "j") setFocusIdx((i) => Math.min(i + 1, shown.length - 1));
      else if (e.key === "k") setFocusIdx((i) => Math.max(i - 1, 0));
      else if (KEY_TO_ACTION[e.key] && shown[focusIdx]) {
        action.mutate({ findingId: shown[focusIdx]!.id, action: KEY_TO_ACTION[e.key]!, prId });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shown, focusIdx, action, prId]);

  return (
    <div>
      <div style={s.toolbar}>
        <div style={s.toggleGroup}>
          {t("panel.hideLowConfidence")}
          <Toggle on={hideLow} onChange={setHideLow} size={16} />
        </div>
      </div>

      <div style={s.list}>
        {shown.length === 0 ? (
          <EmptyState icon="Filter" title={t("panel.noMatchTitle")} body={t("panel.noMatchBody")} />
        ) : (
          shown.map((f, i) => (
            <FindingCard
              key={f.id}
              f={f}
              focused={i === focusIdx}
              defaultExpanded={i === 0}
              pending={action.isPending}
              repoFullName={repoFullName}
              headSha={headSha}
              onAction={(act) => action.mutate({ findingId: f.id, action: act, prId })}
              onCreateEvalCase={() => handleCreateEvalCase(f.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
