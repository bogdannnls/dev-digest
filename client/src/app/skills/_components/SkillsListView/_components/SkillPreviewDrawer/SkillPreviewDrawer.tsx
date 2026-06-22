"use client";

import React from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import { Button, Dropdown, Icon, Toggle } from "@devdigest/ui";
import { useSkill, useUpdateSkill } from "../../../../../../lib/hooks/skills";
import { s } from "./styles";

export function SkillPreviewDrawer({
  skillId,
  onClose,
  onEdit,
  onDeleteRequest,
}: {
  skillId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}) {
  const t = useTranslations("skills");
  const { data: skill } = useSkill(skillId);
  const update = useUpdateSkill();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!skill) return null;

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={skill.name}>
        <div style={s.header}>
          <span style={s.name}>{skill.name}</span>
          <Toggle
            on={skill.enabled}
            onChange={(enabled) => update.mutate({ id: skill.id, patch: { enabled } })}
            size={14}
          />
          <Dropdown
            align="right"
            width={180}
            trigger={
              <button aria-label="more" style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "var(--text-muted)" }}>
                <Icon.MoreHorizontal size={16} />
              </button>
            }
            items={[{ label: t("drawer.deleteMenu"), icon: "Trash", onClick: () => onDeleteRequest(skill.id) }]}
          />
          <button aria-label={t("drawer.closeAria")} onClick={onClose} style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "var(--text-muted)" }}>
            <Icon.X size={16} />
          </button>
        </div>
        <div style={s.body}>
          {skill.description && <p style={s.description}>{skill.description}</p>}
          <div style={s.markdown}>
            <ReactMarkdown>{skill.body}</ReactMarkdown>
          </div>
        </div>
        <div style={s.footer}>
          <Button kind="primary" icon="Edit" onClick={() => onEdit(skill.id)}>
            {t("drawer.edit")}
          </Button>
        </div>
      </aside>
    </>
  );
}
