"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Toggle } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { s } from "./styles";

export function SkillCard({
  skill,
  onClick,
  onToggle,
}: {
  skill: Skill;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("skills");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={skill.name}
      style={s.card(skill.enabled)}
    >
      <div style={s.headerRow}>
        <span style={s.name}>{skill.name}</span>
        <span style={s.badge(skill.type)}>{t(`types.${skill.type}`)}</span>
        {onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle on={skill.enabled} onChange={onToggle} size={14} />
          </div>
        )}
      </div>
      <div style={s.description}>
        {skill.description || t("card.noDescription")}
      </div>
    </button>
  );
}
