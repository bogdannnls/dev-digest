"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, ErrorState, FormField, SelectInput, Skeleton, TextInput, Toggle } from "@devdigest/ui";
import type { Skill, SkillType } from "@devdigest/shared";
import { AppShell } from "../../../../components/app-shell";
import { useCreateSkill, useSkill, useUpdateSkill } from "../../../../lib/hooks/skills";
import { useToast } from "../../../../lib/toast";
import { useActiveRepo } from "../../../../lib/repo-context";
import { TYPE_OPTIONS } from "../SkillsListView/constants";
import { MarkdownSplit } from "./_components/MarkdownSplit";
import { ContextSection } from "./_components/ContextSection";
import { suggestSkillType } from "../../../../lib/skill-type-suggest";
import { s } from "./styles";

type Mode = { mode: "create" } | { mode: "edit"; skillId: string };

export function SkillEditor(props: Mode) {
  const t = useTranslations("skills");
  const router = useRouter();
  const toast = useToast();
  const isEdit = props.mode === "edit";
  const { data: skill, isLoading, isError, refetch } = useSkill(isEdit ? props.skillId : null);
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const { repoId } = useActiveRepo();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<SkillType>("custom");
  const [enabled, setEnabled] = React.useState(true);
  const [body, setBody] = React.useState("");
  const [attachedContextPaths, setAttachedContextPaths] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!skill) return;
    setName(skill.name);
    setDescription(skill.description);
    setType(skill.type);
    setEnabled(skill.enabled);
    setBody(skill.body);
    setAttachedContextPaths(skill.attached_context_paths ?? []);
  }, [skill?.id]);

  const crumb = [
    { label: t("list.breadcrumbLab") },
    { label: t("list.breadcrumb"), href: "/skills" },
    { label: isEdit ? skill?.name ?? t("editor.editTitle") : t("editor.createTitle") },
  ];

  if (isEdit && isError) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title={t("editor.loadErrorTitle")}
          body={t("editor.loadErrorBody")}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  if (isEdit && isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <Skeleton height={28} />
          <Skeleton height={240} />
        </div>
      </AppShell>
    );
  }

  const canSubmit = name.trim().length > 0 && body.trim().length > 0;

  const suggestion = React.useMemo(
    () => suggestSkillType(`${name}\n${description}\n${body}`),
    [name, description, body],
  );
  const showSuggestion = suggestion && suggestion.type !== type;

  const onSave = () => {
    if (isEdit) {
      // `attached_context_paths` is only included when an active repo is
      // selected: the server requires `repo_id` alongside it (T3 `.refine()`)
      // to validate the submitted paths (AC-12c), and without a resolvable
      // repo there is nothing to validate against — omit both rather than
      // risk a 422 that would also block saving unrelated field edits.
      const patch: Partial<
        Pick<Skill, "name" | "description" | "type" | "body" | "enabled" | "attached_context_paths">
      > = { name, description, type, body, enabled };
      if (repoId) {
        patch.attached_context_paths = attachedContextPaths;
      }
      update.mutate(
        { id: props.skillId, patch, repo_id: repoId ?? undefined },
        {
          onSuccess: (data) => toast.success(t("editor.savedToast", { version: data.version })),
          onError: () => toast.error(t("editor.saveError")),
        },
      );
    } else {
      create.mutate(
        { name, description, type, body, enabled },
        {
          onSuccess: (data) => router.push(`/skills/${data.id}`),
          onError: () => toast.error(t("editor.saveError")),
        },
      );
    }
  };

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <h1 style={s.h1}>{isEdit ? t("editor.editTitle") : t("editor.createTitle")}</h1>
        {!isEdit && <p style={s.subtitle}>{t("editor.createSubtitle")}</p>}

        <FormField label={t("editor.name")} required>
          <TextInput value={name} onChange={setName} placeholder={t("editor.namePlaceholder")} mono />
        </FormField>
        <FormField label={t("editor.description")} hint={t("editor.descriptionHint")}>
          <TextInput value={description} onChange={setDescription} placeholder={t("editor.descriptionPlaceholder")} />
        </FormField>
        <FormField label={t("editor.type")}>
          <SelectInput
            value={type}
            onChange={(v) => setType(v as SkillType)}
            options={TYPE_OPTIONS.map((tp) => ({ value: tp, label: t(`types.${tp}`) }))}
            mono={false}
          />
          {showSuggestion && suggestion && (
            <div
              role="status"
              aria-live="polite"
              style={{
                marginTop: 8,
                padding: "6px 10px",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                borderRadius: 999,
                background: "var(--bg-elevated)",
                border: "1px dashed var(--border)",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              ✦ {t("editor.typeSuggestion", { type: t(`types.${suggestion.type}`) })}
              <button
                type="button"
                onClick={() => setType(suggestion.type)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  color: "var(--accent)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                {t("editor.typeSuggestionApply")}
              </button>
            </div>
          )}
        </FormField>
        <FormField label={t("editor.enabled")}>
          <Toggle on={enabled} onChange={setEnabled} size={16} />
        </FormField>
        <FormField label={t("editor.body")}>
          <MarkdownSplit value={body} onChange={setBody} ariaLabel={t("editor.body")} placeholder={t("editor.bodyPlaceholder")} />
        </FormField>

        <FormField label={t("context.title")}>
          {isEdit ? (
            <ContextSection
              repoId={repoId}
              paths={attachedContextPaths}
              onChange={setAttachedContextPaths}
            />
          ) : (
            <p style={s.subtitle}>{t("context.createHint")}</p>
          )}
        </FormField>

        <div style={s.actions}>
          <Button
            kind="primary"
            icon="Check"
            onClick={onSave}
            disabled={!canSubmit || create.isPending || update.isPending}
          >
            {isEdit
              ? (update.isPending ? t("editor.saving") : t("editor.save"))
              : (create.isPending ? t("editor.creating") : t("editor.create"))}
          </Button>
          {isEdit && update.isSuccess && (
            <span style={s.savedNote}>{t("editor.saved", { version: update.data?.version })}</span>
          )}
        </div>
      </div>
    </AppShell>
  );
}
