"use client";

import { useTranslations } from "next-intl";
import { Badge, IconBtn } from "@devdigest/ui";
import type { EvalCase, EvalExpectation, EvalRunRecord } from "@devdigest/shared";
import { SEV_COLOR, SEV_COLOR_FALLBACK, KIND_LABEL_KEY } from "../../constants";
import { s } from "./styles";

/** `EvalCase.expected_output` is typed `z.unknown()` in the shared knowledge
 *  contract (the server persists it validated against `EvalExpectation`, but
 *  the base `EvalCase` schema predates that refinement — contract §1.1/§4.2).
 *  Cast at the one seam that reads it for display. */
function expectationOf(evalCase: EvalCase): EvalExpectation {
  return evalCase.expected_output as EvalExpectation;
}

export interface EvalCaseRowProps {
  evalCase: EvalCase;
  /** This case's row from the most recent batch, or `null`/`undefined` when
   *  the case has never been run (contract §4.7, §2.5). */
  lastRun: EvalRunRecord | null | undefined;
  isRunning: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function EvalCaseRow({ evalCase, lastRun, isRunning, onRun, onEdit, onDelete }: EvalCaseRowProps) {
  const t = useTranslations("eval");
  const expectation = expectationOf(evalCase);

  const resultText = !lastRun
    ? t("evalsTab.neverRun")
    : lastRun.pass
      ? t("evalsTab.passed")
      : t("evalsTab.failed");
  // recall is only shown when the run recorded a number (contract §3.4 — a
  // `must_not_flag` case has no recall denominator and stays `null`, so the
  // suffix is omitted rather than coerced to 0%).
  const recallPct = lastRun?.recall != null ? Math.round(lastRun.recall * 100) : null;

  return (
    <div style={s.row}>
      <div style={s.main}>
        <div style={s.nameLine}>
          <span style={s.name}>{evalCase.name}</span>
          <Badge mono>{t(`expectation.${KIND_LABEL_KEY[expectation.kind]}`)}</Badge>
          {expectation.severity && (
            <Badge color={SEV_COLOR[expectation.severity] ?? SEV_COLOR_FALLBACK}>{expectation.severity}</Badge>
          )}
          {expectation.category && <Badge mono>{expectation.category}</Badge>}
        </div>
        <div style={s.metaLine}>
          <span style={s.fileLine}>
            {expectation.file}:{expectation.start_line}-{expectation.end_line}
          </span>
          <span style={lastRun?.pass ? s.resultPass : lastRun ? s.resultFail : s.resultNone}>
            {resultText}
            {recallPct != null && t("evalsTab.recallSuffix", { recall: recallPct })}
          </span>
        </div>
      </div>
      <div style={s.actions}>
        <IconBtn icon="Play" label={t("evalsTab.run")} onClick={isRunning ? undefined : onRun} active={isRunning} />
        <IconBtn icon="Edit" label={t("evalsTab.edit")} onClick={onEdit} />
        <IconBtn icon="Trash" label={t("evalsTab.delete")} onClick={onDelete} danger />
      </div>
    </div>
  );
}
