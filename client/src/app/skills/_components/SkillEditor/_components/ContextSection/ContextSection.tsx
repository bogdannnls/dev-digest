/* ContextSection — the skill editor's "Project context to use" FormField
   block (AC-37). Mirrors the agent Context tab's attach/reorder/preview
   interactions, but skills have NO inheritance concept — every row here is
   the skill's own attachment, always draggable and removable.

   Controlled component: `paths` + `onChange` are local editor state (owned
   by SkillEditor), persisted together with the rest of the form on Save —
   this matches SkillEditor's existing flat "edit locally, save once" flow
   rather than SkillsTab's per-action optimistic mutations.

   Per plan: the add-doc picker is a dedicated, per-surface duplicate (not a
   shared component) — mirrors AddSkillPicker's shape, sourced from
   `useContextFiles(repoId)` instead of `useSkills()`. */
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
import { Badge, Button, Icon, IconBtn } from "@devdigest/ui";
import type { SpecFile } from "@/lib/types";
import { useContextFiles } from "@/lib/hooks/core";
import { deriveContextKind } from "@/lib/context-kind";
import { ContextPreviewDrawer } from "@/components/ContextPreviewDrawer";
import { s } from "./styles";

export interface ContextSectionProps {
  /** The workspace's currently-active repo selection. `null` when the
   *  workspace has no repo yet — the add-doc picker is disabled in that
   *  case, but existing paths (if any) can still be reordered/removed. */
  repoId: string | null;
  paths: string[];
  onChange: (next: string[]) => void;
}

export function ContextSection({ repoId, paths, onChange }: ContextSectionProps) {
  const t = useTranslations("skills.context");
  const { data: discovered = [] } = useContextFiles(repoId);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = paths.indexOf(active.id as string);
    const newIndex = paths.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(paths, oldIndex, newIndex));
  }

  const attachedSet = React.useMemo(() => new Set(paths), [paths]);

  return (
    <div style={s.wrap}>
      {/* No section title here — the enclosing FormField already renders
          "Project context to use" as its label; this only adds the
          contextual "Add document" action alongside the hint. */}
      <div style={s.header}>
        <p style={s.hint}>{t("hint")}</p>
        {repoId && paths.length > 0 && (
          <Button kind="secondary" size="sm" icon="Plus" onClick={() => setPickerOpen(true)}>
            {t("addDoc")}
          </Button>
        )}
      </div>

      {!repoId && paths.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{t("noRepoTitle")}</div>
          <p style={s.emptyBody}>{t("noRepoBody")}</p>
        </div>
      ) : paths.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{t("emptyTitle")}</div>
          <p style={s.emptyBody}>{t("emptyBody")}</p>
          <Button kind="primary" icon="Plus" onClick={() => setPickerOpen(true)}>
            {t("addDoc")}
          </Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={paths} strategy={verticalListSortingStrategy}>
            <div style={s.list}>
              {paths.map((path) => (
                <SortableRow
                  key={path}
                  path={path}
                  onPreview={() => repoId && setPreviewPath(path)}
                  onRemove={() => onChange(paths.filter((p) => p !== path))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {pickerOpen && (
        <AddDocPicker
          docs={discovered}
          attachedPaths={attachedSet}
          onPick={(path) => onChange([...paths, path])}
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
  onPreview,
  onRemove,
}: {
  path: string;
  onPreview: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: path,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <ContextDocRow
        path={path}
        onPreview={onPreview}
        onRemove={onRemove}
        dragHandleProps={{ ...attributes, ...(listeners as React.HTMLAttributes<HTMLElement>) }}
        isDragging={isDragging}
      />
    </div>
  );
}

function ContextDocRow({
  path,
  onPreview,
  onRemove,
  dragHandleProps,
  isDragging,
}: {
  path: string;
  onPreview: () => void;
  onRemove: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
}) {
  const t = useTranslations("skills.context");
  const kind = deriveContextKind(path);

  return (
    <div style={{ ...s.row, ...(isDragging ? s.dragging : {}) }}>
      {/* Drag handle — keyboard reordering via @dnd-kit's KeyboardSensor reaches
          this element through the accessibility tree; never aria-hidden it
          (only the purely decorative glyph inside is). */}
      <span {...dragHandleProps} aria-label={t("reorderAria")} style={s.handle}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="9" cy="5" r="1" />
          <circle cx="9" cy="12" r="1" />
          <circle cx="9" cy="19" r="1" />
          <circle cx="15" cy="5" r="1" />
          <circle cx="15" cy="12" r="1" />
          <circle cx="15" cy="19" r="1" />
        </svg>
      </span>

      <span style={s.path}>{path}</span>
      <Badge mono>{t(`kind.${kind}`)}</Badge>
      <IconBtn icon="Eye" label={t("previewAria", { path })} onClick={onPreview} />
      <IconBtn icon="Trash" label={t("removeAria", { path })} onClick={onRemove} danger />
    </div>
  );
}

function AddDocPicker({
  docs,
  attachedPaths,
  onPick,
  onClose,
}: {
  docs: SpecFile[];
  attachedPaths: ReadonlySet<string>;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("skills.context.picker");
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = docs.filter(
    (d) => !attachedPaths.has(d.path) && d.path.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={t("title")}>
        <div style={s.drawerHeader}>
          <div style={s.drawerTitleCol}>
            <span style={s.drawerTitle}>{t("title")}</span>
            <span style={s.drawerSubtitle}>{t("subtitle")}</span>
          </div>
          <button
            aria-label={t("closeAria")}
            onClick={onClose}
            style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "var(--text-muted)" }}
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
        <div style={s.pickerList}>
          {filtered.length === 0 ? (
            <div style={s.pickerEmpty}>{t("noResults")}</div>
          ) : (
            filtered.map((d) => (
              <button
                key={d.path}
                type="button"
                style={s.pickerRow}
                onClick={() => {
                  onPick(d.path);
                  onClose();
                }}
              >
                <span style={s.pickerRowPath}>{d.path}</span>
              </button>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
