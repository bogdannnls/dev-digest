"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Modal, Button, FormField, TextInput, Textarea, SelectInput } from "@devdigest/ui";
import type {
  EvalCase,
  EvalCaseManualInput,
  EvalExpectation,
  EvalExpectationKind,
  EvalRunRecord,
} from "@devdigest/shared";
import { useCreateEvalCase, useUpdateEvalCase, useRunEvalBatch } from "@/lib/hooks/eval";
import { EM_DASH } from "@/components/eval/format";
import { s } from "./styles";

export interface EvalCaseModalProps {
  agentId: string;
  /** `null` opens the modal in "create" mode; a case opens it in "edit" mode. */
  evalCase: EvalCase | null;
  /** This case's most recent run, if any — powers the "last run" summary
   *  (contract §4.7). Ignored in create mode. */
  lastRun?: EvalRunRecord | null;
  onClose: () => void;
}

type DiffLine = { text: string; kind: "add" | "del" | "hunk" | "context" };

/** Splits a raw unified-diff fragment into lines tagged for the preview.
 *  Purely presentational — this is not `parseUnifiedDiff`; it never runs
 *  server-side and makes no claim about validity. */
function previewLines(diff: string): DiffLine[] {
  return diff.split("\n").map((text) => {
    if (text.startsWith("@@")) return { text, kind: "hunk" as const };
    if (text.startsWith("+") && !text.startsWith("+++")) return { text, kind: "add" as const };
    if (text.startsWith("-") && !text.startsWith("---")) return { text, kind: "del" as const };
    return { text, kind: "context" as const };
  });
}

export function EvalCaseModal({ agentId, evalCase, lastRun, onClose }: EvalCaseModalProps) {
  const t = useTranslations("eval");
  const initialExpectation = evalCase ? (evalCase.expected_output as EvalExpectation) : null;

  const [name, setName] = useState(evalCase?.name ?? "");
  const [diff, setDiff] = useState(evalCase?.input_diff ?? "");
  const [kind, setKind] = useState<EvalExpectationKind>(initialExpectation?.kind ?? "must_find");
  const [file, setFile] = useState(initialExpectation?.file ?? "");
  const [startLine, setStartLine] = useState(initialExpectation?.start_line ?? 1);
  const [endLine, setEndLine] = useState(initialExpectation?.end_line ?? 1);
  const [notes, setNotes] = useState(evalCase?.notes ?? "");

  const create = useCreateEvalCase(agentId);
  const update = useUpdateEvalCase(agentId);
  const runOne = useRunEvalBatch(agentId);

  const nameValid = name.trim().length > 0;
  const diffValid = diff.trim().length > 0;
  const fileValid = file.trim().length > 0;
  const lineRangeValid = endLine >= startLine;
  const canSave = nameValid && diffValid && fileValid && lineRangeValid;
  const isSaving = create.isPending || update.isPending;

  function handleSave() {
    if (!canSave) return;
    const expected_output: EvalExpectation = {
      kind,
      file: file.trim(),
      start_line: startLine,
      end_line: endLine,
      severity: initialExpectation?.severity ?? null,
      category: initialExpectation?.category ?? null,
      title: initialExpectation?.title ?? null,
    };
    const input: EvalCaseManualInput = {
      name: name.trim(),
      input_diff: diff,
      expected_output,
      notes: notes.trim().length > 0 ? notes.trim() : null,
    };
    if (evalCase) {
      update.mutate({ caseId: evalCase.id, input }, { onSuccess: onClose });
    } else {
      create.mutate(input, { onSuccess: onClose });
    }
  }

  function handleRunCase() {
    if (!evalCase) return;
    runOne.mutate([evalCase.id]);
  }

  // No recall here: it is batch-level only. A single case's recall denominator
  // is its own lone expectation, so the value would restate `pass` for
  // `must_find` and be permanently blank for `must_not_flag`.
  //
  // Both ratios null means the agent returned nothing at all on this case:
  // no findings to divide by, and no citations offered to the grounding gate.
  // Printing "—% · —%" there states a fact about arithmetic, not about the
  // run; the reader needs the latter, especially since it is the single most
  // common reason a `must_find` case fails.
  const producedNothing =
    lastRun != null && lastRun.precision == null && lastRun.citation_accuracy == null;
  const precisionDisp = lastRun?.precision != null ? String(Math.round(lastRun.precision * 100)) : EM_DASH;
  const citationDisp = lastRun?.citation_accuracy != null ? String(Math.round(lastRun.citation_accuracy * 100)) : EM_DASH;
  const durationDisp = lastRun?.duration_ms != null ? (lastRun.duration_ms / 1000).toFixed(1) : EM_DASH;

  const kindOptions = [
    { value: "must_find", label: t("expectation.mustFind") },
    { value: "must_not_flag", label: t("expectation.mustNotFlag") },
  ];

  return (
    <Modal
      width={720}
      title={evalCase ? t("caseEditor.caseTitle", { name: evalCase.name }) : t("caseEditor.newCase")}
      onClose={onClose}
      footer={
        <div style={s.footer}>
          <Button kind="ghost" size="sm" onClick={onClose}>
            {t("compare.close")}
          </Button>
          <div style={s.footerSpacer} />
          {evalCase && (
            <Button kind="secondary" size="sm" icon="Play" disabled={runOne.isPending} onClick={handleRunCase}>
              {runOne.isPending ? t("caseEditor.running") : t("caseEditor.runCase")}
            </Button>
          )}
          <Button kind="primary" size="sm" disabled={!canSave || isSaving} onClick={handleSave}>
            {isSaving ? t("caseEditor.saving") : t("caseEditor.save")}
          </Button>
        </div>
      }
    >
      <div style={s.body}>
        {lastRun && (
          <div style={lastRun.pass ? s.lastRunPass : s.lastRunFail}>
            <div>{lastRun.pass ? t("caseEditor.lastRunPassed") : t("caseEditor.lastRunFailed")}</div>
            <div style={s.lastRunSummary}>
              {producedNothing
                ? t("caseEditor.noFindings", { duration: durationDisp })
                : t("caseEditor.resultSummary", {
                    precision: precisionDisp,
                    citation: citationDisp,
                    duration: durationDisp,
                  })}
            </div>
          </div>
        )}

        <FormField label={t("caseEditor.nameLabel")} required>
          <TextInput value={name} onChange={setName} placeholder={t("caseEditor.namePlaceholder")} />
        </FormField>

        <FormField label={t("caseEditor.inputLabel")} required>
          <div style={s.diffSection}>
            <Textarea
              value={diff}
              onChange={setDiff}
              rows={8}
              mono
              placeholder={t("caseEditor.diffPlaceholder")}
            />
            <div style={s.previewLabel}>{t("caseEditor.preview")}</div>
            <div style={s.previewBox}>
              {diff.trim().length === 0
                ? null
                : previewLines(diff).map((line, i) => (
                    <div key={i} style={s.previewLine[line.kind]}>
                      {line.text || " "}
                    </div>
                  ))}
            </div>
          </div>
        </FormField>

        <FormField label={t("caseEditor.notesLabel")}>
          <Textarea value={notes} onChange={setNotes} rows={3} placeholder={t("caseEditor.notesPlaceholder")} />
        </FormField>

        <FormField label={t("caseEditor.expectedOutput")} required>
          <div style={s.expectationGrid}>
            <SelectInput value={kind} onChange={(v) => setKind(v as EvalExpectationKind)} options={kindOptions} />
            <TextInput value={file} onChange={setFile} placeholder="src/config.ts" />
          </div>
          <div style={s.lineGrid}>
            <label>
              <span style={s.lineLabel}>{t("caseEditor.startLineLabel")}</span>
              <TextInput
                type="number"
                value={String(startLine)}
                onChange={(v) => setStartLine(Math.max(1, parseInt(v, 10) || 1))}
              />
            </label>
            <label>
              <span style={s.lineLabel}>{t("caseEditor.endLineLabel")}</span>
              <TextInput
                type="number"
                value={String(endLine)}
                onChange={(v) => setEndLine(Math.max(1, parseInt(v, 10) || 1))}
              />
            </label>
          </div>
          {!lineRangeValid && <div style={s.error}>end line must be ≥ start line</div>}
        </FormField>
      </div>
    </Modal>
  );
}
