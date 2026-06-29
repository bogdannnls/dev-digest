'use client';
import { useTranslations } from "next-intl";
import { useEvalFixtures } from "@/lib/hooks/agents";
import { s } from "./styles";

interface FixturePickerProps {
  value: string | null;
  onChange: (id: string) => void;
}

export function FixturePicker({ value, onChange }: FixturePickerProps) {
  const t = useTranslations("agents.eval");
  const { data: fixtures = [], isLoading } = useEvalFixtures();

  if (!isLoading && fixtures.length === 0) {
    return <p style={s.empty}>{t("noFixtures")}</p>;
  }

  return (
    <div style={s.field}>
      <label style={s.label}>{t("fixtureLabel")}</label>
      <select
        style={s.select}
        disabled={isLoading}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {fixtures.map((f) => (
          <option key={f.id} value={f.id}>
            {f.title}
          </option>
        ))}
      </select>
    </div>
  );
}
