"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { useSkills, useUpdateSkill } from "../../../../lib/hooks/skills";
import { SkillCard } from "./_components/SkillCard";
import { s } from "./styles";

export function SkillsListView() {
  const t = useTranslations("skills");
  const router = useRouter();
  const { data: skills, isLoading, isError, refetch } = useSkills();
  const update = useUpdateSkill();

  const hasSkills = (skills?.length ?? 0) > 0;

  return (
    <AppShell crumb={[{ label: t("list.breadcrumbLab") }, { label: t("list.breadcrumb") }]}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>{t("list.title")}</h1>
            <p style={s.subtitle}>{t("list.subtitle")}</p>
          </div>
        </div>

        {isLoading && (
          <div style={s.grid}>
            <Skeleton height={120} />
            <Skeleton height={120} />
            <Skeleton height={120} />
          </div>
        )}
        {isError && <ErrorState body={t("list.loadError")} onRetry={() => refetch()} />}
        {!isLoading && !isError && !hasSkills && (
          <EmptyState
            icon="Sparkles"
            title={t("list.emptyTitle")}
            body={t("list.emptyBody")}
            cta={t("list.emptyCta")}
            onCta={() => router.push("/skills/new")}
          />
        )}
        {hasSkills && (
          <div style={s.grid}>
            {skills!.map((sk) => (
              <SkillCard
                key={sk.id}
                skill={sk}
                onClick={() => {/* drawer wiring in Task 12 */}}
                onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
