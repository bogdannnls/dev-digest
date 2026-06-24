"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import type { AgentVersion } from "@devdigest/shared";
import { s } from "../styles";

const FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function VersionRow({
  v,
  isCurrent,
  skillNameById,
}: {
  v: AgentVersion;
  isCurrent: boolean;
  skillNameById: Map<string, string>;
}) {
  const t = useTranslations("agents.versions");
  const [open, setOpen] = React.useState(false);

  const cfg = v.config;
  const hasCustomSchema = cfg.output_schema != null;
  const repoIntelLabel = cfg.repo_intel ? t("repoIntelOn") : t("repoIntelOff");
  const outputSchemaLabel = hasCustomSchema ? t("outputSchemaCustom") : t("outputSchemaDefault");

  return (
    <div style={s.row}>
      <button
        type="button"
        style={s.rowHeader}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={s.versionLabel}>v{v.version}</span>
        <span style={s.timestamp}>{FMT.format(new Date(v.created_at))}</span>
        {isCurrent && <Badge color="var(--accent)">{t("current")}</Badge>}
        <span style={s.chevron}>{open ? <Icon.ChevronDown size={16} /> : <Icon.ChevronRight size={16} />}</span>
      </button>
      {open && (
        <div style={s.rowBody}>
          <dl style={s.defList}>
            <dt style={s.defKey}>{t("fields.provider")}</dt>
            <dd style={s.defVal}>{cfg.provider}</dd>
            <dt style={s.defKey}>{t("fields.model")}</dt>
            <dd style={s.defVal}>{cfg.model}</dd>
            <dt style={s.defKey}>{t("fields.strategy")}</dt>
            <dd style={s.defVal}>{cfg.strategy}</dd>
            <dt style={s.defKey}>{t("fields.ciFailOn")}</dt>
            <dd style={s.defVal}>{cfg.ci_fail_on}</dd>
            <dt style={s.defKey}>{t("fields.repoIntel")}</dt>
            <dd style={s.defVal}>{repoIntelLabel}</dd>
            <dt style={s.defKey}>{t("fields.outputSchema")}</dt>
            <dd style={s.defVal}>{outputSchemaLabel}</dd>
            <dt style={s.defKey}>{t("fields.skills")}</dt>
            <dd style={s.defVal}>
              {cfg.skills.length === 0
                ? t("noSkills")
                : cfg.skills.map((id, i) => {
                    const name = skillNameById.get(id);
                    return (
                      <React.Fragment key={id}>
                        {i > 0 ? ", " : ""}
                        {name ? (
                          <span>{name}</span>
                        ) : (
                          <span>
                            <span>{id}</span>
                            <span style={s.skillDeleted}>{t("skillDeletedSuffix")}</span>
                          </span>
                        )}
                      </React.Fragment>
                    );
                  })}
            </dd>
          </dl>
          <div>
            <div style={{ ...s.defKey, fontSize: 13, marginBottom: 4 }}>{t("fields.systemPrompt")}</div>
            <pre style={s.promptBlock}>{cfg.system_prompt}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
