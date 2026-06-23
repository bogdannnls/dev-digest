"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { s } from "./styles";

export function TrustBanner() {
  const t = useTranslations("skills");
  return (
    <div role="note" style={s.trustBox}>
      <span aria-hidden>⚠</span>
      <span>{t("import.trustBanner")}</span>
    </div>
  );
}
