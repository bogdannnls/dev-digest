"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Dropdown } from "@devdigest/ui";

export function AddSkillButton({ onCreate }: { onCreate: () => void }) {
  const t = useTranslations("skills");
  return (
    <Dropdown
      width={220}
      align="right"
      trigger={
        <Button kind="primary" size="sm" icon="Plus" iconRight="ChevronDown">
          {t("list.addSkill")}
        </Button>
      }
      items={[
        { label: t("list.createFromScratch"), icon: "Edit" as const, onClick: onCreate },
        { divider: true },
        {
          label: t("list.importFromFile"),
          icon: "Upload" as const,
          muted: true,
          onClick: () => undefined,
        },
      ]}
    />
  );
}
