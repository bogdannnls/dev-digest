"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { Agent } from "@devdigest/shared";

export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.skills");
  void agent;
  return (
    <div>
      <h2>{t("title")}</h2>
    </div>
  );
}
