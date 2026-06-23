'use client';
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useEvalFixtures, useSkillsEval } from "@/lib/hooks/agents";
import { FixturePicker } from "./_components/FixturePicker";
import { EvalResultsSplit } from "./_components/EvalResultsSplit";
import { s } from "./styles";

interface SkillsEvalModalProps {
  agentId: string;
  open: boolean;
  onClose: () => void;
}

export function SkillsEvalModal({ agentId, open, onClose }: SkillsEvalModalProps) {
  const t = useTranslations("agents.eval");
  const { data: fixtures = [] } = useEvalFixtures();
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const { mutate, isPending, isError, data, reset } = useSkillsEval(agentId);

  useEffect(() => {
    if (fixtureId == null && fixtures[0]) {
      setFixtureId(fixtures[0].id);
    }
  }, [fixtures, fixtureId]);

  if (!open) return null;

  const run = () => {
    if (fixtureId) mutate({ fixture_id: fixtureId });
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <div style={s.overlay} role="dialog" aria-modal={true}>
      <div style={s.dialog}>
        <header style={s.header}>
          <h2>{t("title")}</h2>
          <p>{t("subtitle")}</p>
        </header>
        <section style={s.body}>
          {isPending ? (
            <div style={s.runningBox}>{t("running")}</div>
          ) : isError ? (
            <div style={s.errorBox}>
              <p>{t("error")}</p>
              <button onClick={run}>{t("retry")}</button>
            </div>
          ) : data ? (
            <EvalResultsSplit result={data} />
          ) : (
            <FixturePicker value={fixtureId} onChange={setFixtureId} />
          )}
        </section>
        <footer style={s.footer}>
          {data || isError ? (
            <button onClick={close}>{t("close")}</button>
          ) : isPending ? (
            <button disabled aria-label={t("running")} />
          ) : (
            <>
              <button onClick={close}>{t("cancel")}</button>
              <button onClick={run} disabled={!fixtureId}>
                {t("run")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
