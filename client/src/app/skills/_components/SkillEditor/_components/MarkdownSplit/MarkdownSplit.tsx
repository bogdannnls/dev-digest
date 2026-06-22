"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import { useTranslations } from "next-intl";
import { s } from "./styles";

export function MarkdownSplit({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
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
      <div style={showPreview ? s.split : s.splitSolo}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={s.textarea}
          aria-label={ariaLabel ?? "Markdown body"}
        />
        {showPreview && (
          <div style={{ ...s.pane, ...s.previewSeparator }}>
            <ReactMarkdown>{value}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
