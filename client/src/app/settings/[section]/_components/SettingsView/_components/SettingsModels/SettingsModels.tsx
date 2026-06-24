"use client";

import React, { useState } from "react";
import { useTranslations } from "next-intl";
import { FormField, SearchableSelect, SelectInput, Icon } from "@devdigest/ui";
import { useSettings, useUpdateSettings } from "../../../../../../../lib/hooks";
import { useProviderModels } from "../../../../../../../lib/hooks/agents";
import { toModelOptions } from "../../../../../../../lib/model-label";
import { FEATURE_MODELS } from "../../../../../../../lib/feature-models";
import type {
  FeatureModelChoice,
  FeatureModelDef,
  FeatureModelId,
  Provider,
} from "../../../../../../../lib/types";
import { SectionTitle } from "../SectionTitle";
import { s } from "./styles";

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
];

interface RowProps {
  f: FeatureModelDef;
  current: FeatureModelChoice | undefined;
  isDefault: boolean;
  onSave: (choice: FeatureModelChoice) => void;
}

function FeatureModelRow({ f, current, isDefault, onSave }: RowProps) {
  const t = useTranslations("settings");

  const [localProvider, setLocalProvider] = useState<Provider>(
    (current?.provider ?? f.defaultProvider) as Provider,
  );
  const [localModel, setLocalModel] = useState(current?.model ?? f.defaultModel);

  const { data: models } = useProviderModels(localProvider);
  const baseOptions = toModelOptions(models);
  const options = baseOptions.some((o) => (typeof o === "string" ? o : o.value) === localModel)
    ? baseOptions
    : [localModel, ...baseOptions];

  const handleProviderChange = (p: string) => {
    setLocalProvider(p as Provider);
    setLocalModel("");
  };

  const handleModelChange = (m: string) => {
    setLocalModel(m);
    onSave({ provider: localProvider, model: m });
  };

  const needsModelPick = localModel === "";

  return (
    <div style={s.row}>
      <FormField
        label={
          <>
            {f.label}
            {isDefault && <span style={s.defaultTag}>{t("models.usingDefault")}</span>}
          </>
        }
        hint={f.description}
      >
        <div style={s.pickerRow}>
          <div style={s.providerSelect}>
            <SelectInput
              value={localProvider}
              onChange={handleProviderChange}
              options={PROVIDER_OPTIONS}
              mono={false}
            />
          </div>
          <div style={s.modelSelect}>
            <SearchableSelect
              value={localModel}
              onChange={handleModelChange}
              options={options}
              placeholder={t("models.search")}
            />
          </div>
        </div>
        {needsModelPick && <div style={s.unsavedHint}>{t("models.pickModelHint")}</div>}
      </FormField>
    </div>
  );
}

/**
 * Settings → Feature Models. One provider+model picker per system LLM feature.
 * Provider selection determines which model list is loaded live (openai / anthropic / openrouter).
 * The choice persists to `settings.feature_models`; each feature falls back to its registry default.
 */
export function SettingsModels() {
  const t = useTranslations("settings");
  const { data: settings } = useSettings();
  const update = useUpdateSettings();

  const chosen = (settings?.feature_models ?? {}) as Partial<Record<FeatureModelId, FeatureModelChoice>>;

  const save = (id: FeatureModelId, choice: FeatureModelChoice) => {
    update.mutate({ feature_models: { ...chosen, [id]: choice } });
  };

  return (
    <div style={s.wrap}>
      <SectionTitle title={t("models.title")} body={t("models.body")} />

      {FEATURE_MODELS.map((f) => (
        <FeatureModelRow
          key={f.id}
          f={f}
          current={chosen[f.id]}
          isDefault={!chosen[f.id]}
          onSave={(choice) => save(f.id, choice)}
        />
      ))}

      <div style={s.note}>
        <Icon.Info size={15} style={s.noteIcon} />
        <span>{t("models.liveNote")}</span>
      </div>
    </div>
  );
}
