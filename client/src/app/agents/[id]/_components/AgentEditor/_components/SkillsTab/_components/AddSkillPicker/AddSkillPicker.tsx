"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import { useSkills } from "@/lib/hooks/skills";
import { TYPE_BADGE_BG } from "../../constants";
import { s } from "./styles";

export interface AddSkillPickerProps {
  linkedIds: ReadonlySet<string>;
  onPick: (skillId: string) => void;
  onClose: () => void;
}

export function AddSkillPicker({ linkedIds, onPick, onClose }: AddSkillPickerProps) {
  const t = useTranslations("agents.skills.picker");
  const { data: skills = [] } = useSkills();
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = skills.filter(
    (sk) =>
      !linkedIds.has(sk.id) &&
      sk.name.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={t("title")}>
        <div style={s.header}>
          <div style={s.titleCol}>
            <span style={s.title}>{t("title")}</span>
            <span style={s.subtitle}>{t("subtitle")}</span>
          </div>
          <button
            aria-label="close picker"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              padding: 4,
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
          >
            <Icon.X size={16} />
          </button>
        </div>
        <div style={s.searchWrap}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchPlaceholder")}
            style={s.search}
          />
        </div>
        <div style={s.list}>
          {filtered.length === 0 ? (
            <div style={s.empty}>{t("noUnlinked")}</div>
          ) : (
            filtered.map((sk) => (
              <button
                key={sk.id}
                type="button"
                style={s.row}
                onClick={() => {
                  onPick(sk.id);
                  onClose();
                }}
              >
                <span style={s.rowName}>{sk.name}</span>
                <Badge color={TYPE_BADGE_BG[sk.type]} mono>
                  {sk.type}
                </Badge>
              </button>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
