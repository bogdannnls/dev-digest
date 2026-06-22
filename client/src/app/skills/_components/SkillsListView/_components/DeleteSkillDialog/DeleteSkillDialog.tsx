"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@devdigest/ui";
import { useSkill, useSkillUsage, useDeleteSkill } from "../../../../../../lib/hooks/skills";

export function DeleteSkillDialog({
  skillId,
  onClose,
  onDeleted,
}: {
  skillId: string;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const t = useTranslations("skills");
  const { data: skill } = useSkill(skillId);
  const { data: usage } = useSkillUsage(skillId);
  const del = useDeleteSkill();

  if (!skill) return null;

  const count = usage?.agent_count ?? 0;
  const body = count === 0
    ? t("delete.bodyZero", { name: skill.name })
    : t("delete.bodyN", { name: skill.name, count });

  return (
    <Modal onClose={onClose} title={t("delete.title")}>
      <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)", marginBottom: 16 }}>
        {body}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button kind="ghost" onClick={onClose}>{t("delete.cancel")}</Button>
        <Button
          kind="danger"
          icon="Trash"
          disabled={del.isPending}
          onClick={() => {
            del.mutate(skillId, {
              onSuccess: () => {
                onDeleted?.();
                onClose();
              },
            });
          }}
        >
          {del.isPending ? t("delete.deleting") : t("delete.confirm")}
        </Button>
      </div>
    </Modal>
  );
}
