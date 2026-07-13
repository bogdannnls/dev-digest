/* ContextTab — agent editor "Context" tab (L05). Mirrors SkillsTab's dnd-kit
   list pattern: the agent's OWN attached_context_paths are editable,
   reorderable, and removable (AC-35/36), persisted via the existing
   PUT /agents/:id update mutation (attached_context_paths + the transient
   repo_id AC-12c requires). The INHERITED set — computed client-side from
   the agent's enabled skills, in skill order, deduped first-wins against the
   agent's own list — is display-only: greyed, no drag handle, no remove
   action (AC-18/20/21). This is a deliberate re-implementation of T4's
   server-side merge rule for preview purposes only; it is not shared code. */
"use client";

import React from "react";
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
import type { Agent } from "@devdigest/shared";
import { useAgentSkills, useUpdateAgent } from "@/lib/hooks/agents";
import { useSkills } from "@/lib/hooks/skills";
import { useActiveRepo } from "@/lib/repo-context";
import { ContextPreviewDrawer } from "@/components/ContextPreviewDrawer";
import { ContextDocRow } from "./_components/ContextDocRow/ContextDocRow";
import { AddContextDocPicker } from "./_components/AddContextDocPicker/AddContextDocPicker";
import { s } from "./styles";

export function ContextTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.context");
  const { repoId } = useActiveRepo();
  const { data: links = [] } = useAgentSkills(agent.id);
  const { data: allSkills = [] } = useSkills();
  const updateAgent = useUpdateAgent();

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);

  const ownPaths = agent.attached_context_paths ?? [];
  const ownSet = React.useMemo(() => new Set(ownPaths), [ownPaths]);

  const skillsById = React.useMemo(
    () => new Map(allSkills.map((sk) => [sk.id, sk])),
    [allSkills],
  );

  // AC-18 (client-side preview mirror): agent's own list is separate from
  // this; here we compute ONLY the inherited tail — enabled skills, in skill
  // order, each skill's own document order, deduped first-wins, excluding
  // anything already in the agent's own list.
  const inheritedPaths = React.useMemo(() => {
    const enabledInOrder = links
      .filter((l) => l.enabled)
      .slice()
      .sort((a, b) => a.order - b.order);
    const seen = new Set(ownSet);
    const result: string[] = [];
    for (const link of enabledInOrder) {
      const skill = skillsById.get(link.skill_id);
      for (const path of skill?.attached_context_paths ?? []) {
        if (seen.has(path)) continue;
        seen.add(path);
        result.push(path);
      }
    }
    return result;
  }, [links, skillsById, ownSet]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function persist(next: string[]) {
    // repo_id is required by the server whenever attached_context_paths is
    // present (AC-12c) — without an active repo there's nothing to validate
    // against, so skip rather than send an invalid request.
    if (!repoId) return;
    updateAgent.mutate({ id: agent.id, patch: { attached_context_paths: next }, repoId });
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = ownPaths.findIndex((p) => p === active.id);
    const newIndex = ownPaths.findIndex((p) => p === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    persist(arrayMove(ownPaths, oldIndex, newIndex));
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>{t("title")}</span>
        {repoId && ownPaths.length > 0 && (
          <Button kind="primary" size="sm" icon="Plus" onClick={() => setPickerOpen(true)}>
            {t("addDocument")}
          </Button>
        )}
      </div>
      <p style={s.hint}>{t("orderHint")}</p>

      {ownPaths.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{t("emptyTitle")}</div>
          <p style={s.emptyBody}>{t("emptyBody")}</p>
          {repoId && (
            <Button kind="primary" icon="Plus" onClick={() => setPickerOpen(true)}>
              {t("addDocument")}
            </Button>
          )}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ownPaths} strategy={verticalListSortingStrategy}>
            <div style={s.list}>
              {ownPaths.map((path) => (
                <SortableRow
                  key={path}
                  path={path}
                  onRemove={() => persist(ownPaths.filter((p) => p !== path))}
                  onPreview={() => setPreviewPath(path)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {inheritedPaths.length > 0 && (
        <>
          <p style={s.inheritedLabel}>{t("inheritedLabel")}</p>
          <div style={s.list}>
            {inheritedPaths.map((path) => (
              <ContextDocRow
                key={path}
                path={path}
                inherited
                onPreview={() => setPreviewPath(path)}
              />
            ))}
          </div>
        </>
      )}

      {pickerOpen && repoId && (
        <AddContextDocPicker
          repoId={repoId}
          attachedPaths={ownSet}
          onPick={(path) => persist([...ownPaths, path])}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {previewPath && repoId && (
        <ContextPreviewDrawer
          repoId={repoId}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  );
}

function SortableRow({
  path,
  onRemove,
  onPreview,
}: {
  path: string;
  onRemove: () => void;
  onPreview: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: path });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <ContextDocRow
        path={path}
        onRemove={onRemove}
        onPreview={onPreview}
        dragHandleProps={{ ...attributes, ...(listeners as React.HTMLAttributes<HTMLElement>) }}
        isDragging={isDragging}
      />
    </div>
  );
}
