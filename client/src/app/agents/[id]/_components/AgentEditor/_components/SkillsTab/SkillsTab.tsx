"use client";

import React, { useState } from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@devdigest/ui";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";
import {
  useAgentSkills,
  useSetAgentSkills,
  useLinkAgentSkill,
  useUnlinkAgentSkill,
  useSetAgentSkillEnabled,
} from "@/lib/hooks/agents";
import { useSkills } from "@/lib/hooks/skills";
import { LinkedSkillRow } from "./_components/LinkedSkillRow";
import { AddSkillPicker } from "./_components/AddSkillPicker";
import { SkillsEvalModal } from "./_components/SkillsEvalModal";
import { s } from "./styles";

export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.skills");
  const { data: links = [] } = useAgentSkills(agent.id);
  const { data: allSkills = [] } = useSkills();
  const setSkills = useSetAgentSkills(agent.id);
  const linkSkill = useLinkAgentSkill(agent.id);
  const unlinkSkill = useUnlinkAgentSkill(agent.id);
  const setEnabled = useSetAgentSkillEnabled(agent.id);

  const [filter, setFilter] = React.useState("");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [evalOpen, setEvalOpen] = useState(false);

  const skillsById = React.useMemo(
    () => new Map(allSkills.map((sk) => [sk.id, sk])),
    [allSkills],
  );
  const linkedIds = React.useMemo(
    () => new Set(links.map((l) => l.skill_id)),
    [links],
  );

  const enabledCount = links.filter((l) => l.enabled).length;
  const hasEnabledLink = links.some((l) => l.enabled);

  const filtered = links.filter((l) => {
    const sk = skillsById.get(l.skill_id);
    if (!sk) return false;
    return sk.name.toLowerCase().includes(filter.trim().toLowerCase());
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = links.findIndex((l) => l.skill_id === active.id);
    const newIndex = links.findIndex((l) => l.skill_id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(links, oldIndex, newIndex);
    setSkills.mutate({ skill_ids: next.map((l) => l.skill_id) });
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>{t("title")}</span>
        <span style={s.pill}>{t("enabledCount", { enabled: enabledCount, total: links.length })}</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("filterPlaceholder")}
          style={s.filter}
        />
        {links.length > 0 && (
          <Button kind="primary" size="sm" icon="Plus" onClick={() => setPickerOpen(true)}>
            {t("addSkill")}
          </Button>
        )}
      </div>
      <p style={s.hint}>{t("orderHint")}</p>

      {links.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{t("emptyTitle")}</div>
          <p style={s.emptyBody}>{t("emptyBody")}</p>
          <Button kind="primary" icon="Plus" onClick={() => setPickerOpen(true)}>
            {t("addSkill")}
          </Button>
        </div>
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={filtered.map((l) => l.skill_id)}
              strategy={verticalListSortingStrategy}
            >
              <div style={s.list}>
                {filtered.map((link) => {
                  const skill = skillsById.get(link.skill_id);
                  if (!skill) return null;
                  return (
                    <SortableRow
                      key={link.skill_id}
                      link={link}
                      skill={skill}
                      onToggle={(enabled) =>
                        setEnabled.mutate({ skillId: link.skill_id, enabled })
                      }
                      onRemove={() => unlinkSkill.mutate(link.skill_id)}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>

          <Button
            kind="secondary"
            size="sm"
            disabled={!hasEnabledLink}
            title={!hasEnabledLink ? t("evalEmpty") : undefined}
            onClick={() => setEvalOpen(true)}
          >
            {t("evalButton")}
          </Button>

          <SkillsEvalModal
            agentId={agent.id}
            open={evalOpen}
            onClose={() => setEvalOpen(false)}
          />
        </>
      )}

      {pickerOpen && (
        <AddSkillPicker
          linkedIds={linkedIds}
          onPick={(skillId) => linkSkill.mutate({ skill_id: skillId })}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function SortableRow({
  link,
  skill,
  onToggle,
  onRemove,
}: {
  link: AgentSkillLink;
  skill: Skill;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: link.skill_id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <LinkedSkillRow
        skill={skill}
        enabled={link.enabled}
        onToggleEnabled={onToggle}
        onRemove={onRemove}
        dragHandleProps={{ ...attributes, ...(listeners as React.HTMLAttributes<HTMLElement>) }}
        isDragging={isDragging}
      />
    </div>
  );
}
