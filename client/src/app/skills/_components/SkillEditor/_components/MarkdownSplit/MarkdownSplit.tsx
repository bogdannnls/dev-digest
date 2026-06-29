"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Markdown } from "@devdigest/ui";
import { s } from "./styles";

export function MarkdownSplit({
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const t = useTranslations("skills");
  const [showPreview, setShowPreview] = React.useState(true);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <button
          type="button"
          aria-pressed={showPreview}
          onClick={() => setShowPreview((v) => !v)}
          style={s.toggleButton(showPreview)}
        >
          {t("editor.previewToggle")}
        </button>
      </div>
      <div style={showPreview ? s.split : undefined}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={s.textarea}
          aria-label={ariaLabel ?? "Markdown body"}
          placeholder={placeholder}
        />
        {showPreview && (
          <div style={{ ...s.pane, ...s.previewSeparator }}>
            <Markdown>{value}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
