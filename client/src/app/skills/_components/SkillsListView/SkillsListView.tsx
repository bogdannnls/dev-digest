"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { AppShell } from "../../../../components/app-shell";
import { useSkills, useUpdateSkill } from "../../../../lib/hooks/skills";
import { SkillCard } from "./_components/SkillCard";
import { SkillsToolbar } from "./_components/SkillsToolbar";
import { SkillPreviewDrawer } from "./_components/SkillPreviewDrawer";
import { DeleteSkillDialog } from "./_components/DeleteSkillDialog";
import { filterSkills } from "./helpers";
import { s } from "./styles";

export function SkillsListView() {
  const t = useTranslations("skills");
  const router = useRouter();
  const { data: skills, isLoading, isError, refetch } = useSkills();
  const update = useUpdateSkill();
  const [query, setQuery] = React.useState("");
  const [types, setTypes] = React.useState<Set<SkillType>>(new Set());
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

  const hasSkills = (skills?.length ?? 0) > 0;
  const visible = filterSkills(skills ?? [], query, types);
  const filteredOut = hasSkills && visible.length === 0;

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
          <SkillsToolbar query={query} onQuery={setQuery} types={types} onTypes={setTypes} />
        )}
        {filteredOut && (
          <EmptyState
            icon="Search"
            title={t("list.noMatchTitle")}
            body={t("list.noMatchBody")}
            cta={t("list.noMatchCta")}
            onCta={() => { setQuery(""); setTypes(new Set()); }}
          />
        )}
        {visible.length > 0 && (
          <div style={s.grid}>
            {visible.map((sk) => (
              <SkillCard
                key={sk.id}
                skill={sk}
                onClick={() => setSelectedId(sk.id)}
                onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
              />
            ))}
          </div>
        )}
      </div>
      {selectedId && (
        <SkillPreviewDrawer
          skillId={selectedId}
          onClose={() => setSelectedId(null)}
          onEdit={(id) => router.push(`/skills/${id}`)}
          onDeleteRequest={(id) => setPendingDelete(id)}
        />
      )}
      {pendingDelete && (
        <DeleteSkillDialog
          skillId={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </AppShell>
  );
}
