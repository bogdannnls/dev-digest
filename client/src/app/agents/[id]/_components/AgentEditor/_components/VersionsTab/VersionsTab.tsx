"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Skeleton } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { useAgentVersions } from "../../../../../../../lib/hooks/agents";
import { useSkills } from "../../../../../../../lib/hooks/skills";
import { VersionRow } from "./_components/VersionRow";
import { s } from "./styles";

/** Versions tab — read-only history of agent_versions snapshots, newest first. */
export function VersionsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.versions");
  const versions = useAgentVersions(agent.id);
  const skills = useSkills();

  const skillNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const sk of skills.data ?? []) m.set(sk.id, sk.name);
    return m;
  }, [skills.data]);

  if (versions.isLoading) {
    return (
      <div style={s.wrap}>
        <div style={s.header}>
          <h2 style={s.title}>{t("title")}</h2>
        </div>
        <div style={s.list}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </div>
    );
  }

  if (versions.isError) {
    return (
      <div style={s.wrap}>
        <div style={s.header}>
          <h2 style={s.title}>{t("title")}</h2>
        </div>
        <div role="alert" style={s.loadError}>
          <span>{t("loadError")}</span>
          <button
            type="button"
            onClick={() => versions.refetch()}
            style={{ background: "transparent", border: 0, color: "var(--accent)", cursor: "pointer" }}
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  const data = versions.data ?? [];

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.title}>{t("title")}</h2>
        <Badge color="var(--text-secondary)">{t("count", { count: data.length })}</Badge>
      </div>
      {data.length <= 1 ? (
        <div style={s.onlyOne}>{t("onlyOne")}</div>
      ) : (
        <div style={s.list}>
          {data.map((v) => (
            <VersionRow
              key={v.version}
              v={v}
              isCurrent={v.version === agent.version}
              skillNameById={skillNameById}
            />
          ))}
        </div>
      )}
    </div>
  );
}
