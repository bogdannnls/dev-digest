"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { TYPE_OPTIONS } from "../../constants";
import { s } from "./styles";

export function SkillsToolbar({
  query,
  onQuery,
  types,
  onTypes,
  actions,
}: {
  query: string;
  onQuery: (v: string) => void;
  types: ReadonlySet<SkillType>;
  onTypes: (next: Set<SkillType>) => void;
  actions?: React.ReactNode;
}) {
  const t = useTranslations("skills");

  const toggle = (type: SkillType) => {
    const next = new Set(types);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onTypes(next);
  };

  return (
    <div style={s.row}>
      <div style={s.search}>
        <Icon.Search size={13} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t("list.searchPlaceholder")}
          style={s.searchInput}
        />
      </div>
      <div style={s.chips} role="group" aria-label={t("list.filterByType")}>
        {TYPE_OPTIONS.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={types.has(type)}
            onClick={() => toggle(type)}
            style={s.chip(types.has(type))}
          >
            {t(`types.${type}`)}
          </button>
        ))}
      </div>
      <div style={s.spacer} />
      {actions}
    </div>
  );
}
