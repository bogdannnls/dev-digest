"use client";

import React, { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button, Markdown, Modal } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { useCreateSkill, useImportSkillPreview } from "../../../../../../lib/hooks/skills";
import type { ParsedImportPayload } from "../../../../../../lib/hooks/skills";
import { TrustBanner } from "./TrustBanner";
import { s } from "./styles";

const MAX_SIZE = 256 * 1024; // 256 KB

const TYPE_OPTIONS = [
  { value: "rubric" as const, key: "rubric" as const },
  { value: "convention" as const, key: "convention" as const },
  { value: "security" as const, key: "security" as const },
  { value: "custom" as const, key: "custom" as const },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

type State =
  | { phase: "pick" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "preview"; data: ParsedImportPayload; name: string; description: string; type: SkillType };

export function ImportSkillDialog({ open, onClose }: Props) {
  const t = useTranslations("skills");
  const router = useRouter();
  const inputId = useId();
  const [state, setState] = useState<State>({ phase: "pick" });

  const preview = useImportSkillPreview();
  const create = useCreateSkill();

  if (!open) return null;

  function handleClose() {
    setState({ phase: "pick" });
    preview.reset();
    onClose();
  }

  async function handleFile(file: File) {
    // S6: case-insensitive extension check to match server behaviour
    if (!file.name.toLowerCase().endsWith(".md")) {
      setState({ phase: "error", message: t("import.wrongExt") });
      return;
    }
    if (file.size > MAX_SIZE) {
      setState({ phase: "error", message: t("import.tooLarge") });
      return;
    }
    setState({ phase: "loading" });
    try {
      const data = await preview.mutateAsync(file);
      setState({
        phase: "preview",
        data,
        name: data.name,
        description: data.description,
        type: data.type,
      });
    } catch (e) {
      // S4: surface structured server error codes when available
      let msg = t("import.parseError");
      if (e && typeof e === "object" && "details" in e) {
        const code = (e as { details?: { code?: string } }).details?.code;
        if (code === "too_large") msg = t("import.tooLarge");
        else if (code === "wrong_extension") msg = t("import.wrongExt");
      }
      setState({ phase: "error", message: msg });
    }
  }

  async function handleCreate() {
    if (state.phase !== "preview") return;
    const result = await create.mutateAsync({
      name: state.name,
      description: state.description,
      type: state.type,
      body: state.data.body,
      source: "imported_url",
    });
    onClose();
    router.push(`/skills/${result.id}`);
  }

  const isPreview = state.phase === "preview";
  const isLoading = state.phase === "loading";

  const footer = isPreview ? (
    <div style={s.footer}>
      <Button kind="ghost" onClick={handleClose} disabled={create.isPending}>
        {t("import.cancel")}
      </Button>
      <Button kind="primary" onClick={handleCreate} disabled={create.isPending}>
        {create.isPending ? t("import.creating") : t("import.create")}
      </Button>
    </div>
  ) : null;

  return (
    <Modal
      title={t("import.title")}
      subtitle={t("import.subtitle")}
      onClose={handleClose}
      footer={footer}
      width={isPreview ? 900 : 520}
    >
      <div style={{ padding: "0 24px 24px" }}>
        {/* Picker / error state */}
        {(state.phase === "pick" || state.phase === "error" || state.phase === "loading") && (
          <div style={s.picker}>
            {state.phase === "error" && (
              <div style={s.errorBox} role="alert">
                {state.message}
              </div>
            )}
            <label style={s.pickerBox}>
              <input
                type="file"
                accept=".md,text/markdown"
                aria-label={t("import.drop")}
                style={s.hiddenInput}
                disabled={isLoading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // S2: reset so the same filename re-triggers onChange after an error
                  e.target.value = "";
                  if (file) handleFile(file);
                }}
              />
              {isLoading ? "…" : t("import.drop")}
            </label>
            <span style={s.hint}>{t("import.hint")}</span>
          </div>
        )}

        {/* Preview state */}
        {state.phase === "preview" && (
          <>
            <TrustBanner />

            {state.data.warnings.length > 0 && (
              <div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{t("import.warningsLabel")}</span>
                <div style={s.warningsRow}>
                  {state.data.warnings.map((w, i) => (
                    <span key={i} style={s.warningChip}>
                      {w}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={s.previewGrid}>
              {/* Left column: editable fields */}
              <div>
                <div style={s.field}>
                  <label style={s.label} htmlFor={`${inputId}-name`}>{t("import.nameLabel")}</label>
                  <input
                    id={`${inputId}-name`}
                    style={s.input}
                    value={state.name}
                    disabled={create.isPending}
                    onChange={(e) => setState({ ...state, name: e.target.value })}
                  />
                </div>
                <div style={s.field}>
                  {/* M1: type is now a constrained select, not a free-text input */}
                  <label style={s.label} htmlFor={`${inputId}-type`}>{t("import.typeLabel")}</label>
                  <select
                    id={`${inputId}-type`}
                    style={s.input}
                    value={state.type}
                    disabled={create.isPending}
                    onChange={(e) => setState({ ...state, type: e.target.value as SkillType })}
                  >
                    {TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{t(`types.${o.key}`)}</option>
                    ))}
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label} htmlFor={`${inputId}-desc`}>{t("import.descriptionLabel")}</label>
                  <input
                    id={`${inputId}-desc`}
                    style={s.input}
                    value={state.description}
                    disabled={create.isPending}
                    onChange={(e) => setState({ ...state, description: e.target.value })}
                  />
                </div>
              </div>

              {/* Right column: body preview */}
              <div>
                <div style={s.field}>
                  <label style={s.label}>{t("import.bodyLabel")}</label>
                  <div style={s.bodyPreview}>
                    <Markdown>{state.data.body}</Markdown>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
