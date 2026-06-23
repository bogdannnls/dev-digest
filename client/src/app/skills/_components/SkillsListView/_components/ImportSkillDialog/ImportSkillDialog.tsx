"use client";

import React, { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button, Markdown, Modal } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { useCreateSkill, useImportSkillPreview } from "../../../../../../lib/hooks/skills";
import type { ParsedImportPayload } from "../../../../../../lib/hooks/skills";
import { TrustBanner } from "./TrustBanner";
import { s } from "./styles";

const MAX_SIZE = 256 * 1024; // 256 KB

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
  const inputRef = useRef<HTMLInputElement>(null);
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
    if (!file.name.endsWith(".md")) {
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
    } catch {
      setState({ phase: "error", message: t("import.parseError") });
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
                ref={inputRef}
                type="file"
                accept=".md,text/markdown"
                aria-label={t("import.drop")}
                style={s.hiddenInput}
                disabled={isLoading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
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
                    onChange={(e) => setState({ ...state, name: e.target.value })}
                  />
                </div>
                <div style={s.field}>
                  <label style={s.label} htmlFor={`${inputId}-type`}>{t("import.typeLabel")}</label>
                  <input
                    id={`${inputId}-type`}
                    style={s.input}
                    value={state.type}
                    onChange={(e) => setState({ ...state, type: e.target.value as SkillType })}
                  />
                </div>
                <div style={s.field}>
                  <label style={s.label} htmlFor={`${inputId}-desc`}>{t("import.descriptionLabel")}</label>
                  <input
                    id={`${inputId}-desc`}
                    style={s.input}
                    value={state.description}
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
