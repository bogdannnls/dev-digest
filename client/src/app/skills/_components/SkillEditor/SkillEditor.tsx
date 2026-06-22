"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ErrorState, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { useSkill } from "../../../../lib/hooks/skills";
import { s } from "./styles";

type Mode = { mode: "create" } | { mode: "edit"; skillId: string };

export function SkillEditor(props: Mode) {
  const t = useTranslations("skills");
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const { data: skill, isLoading, isError, refetch } = useSkill(isEdit ? props.skillId : null);

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

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <h1 style={s.h1}>
          {isEdit ? t("editor.editTitle") : t("editor.createTitle")}
        </h1>
        <p style={s.subtitle}>{t("editor.createSubtitle")}</p>
        {/* form fields land in Task 16 */}
      </div>
    </AppShell>
  );
}
