'use client';
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@devdigest/ui";
import { useEvalFixtures, useSkillsEval } from "@/lib/hooks/agents";
import { FixturePicker } from "./_components/FixturePicker";
import { EvalResultsSplit } from "./_components/EvalResultsSplit";
import { s } from "./styles";

interface SkillsEvalModalProps {
  agentId: string;
  open: boolean;
  onClose: () => void;
}

const MODAL_WIDTH = 900;

export function SkillsEvalModal({ agentId, open, onClose }: SkillsEvalModalProps) {
  const t = useTranslations("agents.eval");
  const { data: fixtures = [] } = useEvalFixtures();
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const { mutate, isPending, isError, data, reset } = useSkillsEval(agentId);

  const effectiveFixtureId = selectedFixtureId ?? fixtures[0]?.id ?? null;

  if (!open) return null;

  const run = () => {
    if (effectiveFixtureId) mutate({ fixture_id: effectiveFixtureId });
  };

  const close = () => {
    reset();
    onClose();
  };

  const footer = isPending ? null : data || isError ? (
    <div style={s.footer}>
      <Button kind="ghost" onClick={close}>{t("close")}</Button>
    </div>
  ) : (
    <div style={s.footer}>
      <Button kind="ghost" onClick={close}>{t("cancel")}</Button>
      <Button kind="primary" onClick={run} disabled={!effectiveFixtureId}>{t("run")}</Button>
    </div>
  );

  return (
    <Modal
      width={MODAL_WIDTH}
      title={t("title")}
      subtitle={t("subtitle")}
      onClose={close}
      footer={footer}
    >
      <div style={s.body}>
        {isPending ? (
          <div style={s.runningBox}>{t("running")}</div>
        ) : isError ? (
          <div style={s.errorBox}>
            <p>{t("error")}</p>
            <Button kind="secondary" onClick={run}>{t("retry")}</Button>
          </div>
        ) : data ? (
          <EvalResultsSplit result={data} />
        ) : (
          <FixturePicker value={effectiveFixtureId} onChange={setSelectedFixtureId} />
        )}
      </div>
    </Modal>
  );
}
