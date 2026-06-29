import type { SkillType } from "@devdigest/shared";

export const TYPE_OPTIONS: readonly SkillType[] = [
  "rubric",
  "convention",
  "security",
  "custom",
] as const;

/** Badge background per type (CSS var name). */
export const TYPE_BADGE_BG: Record<SkillType, string> = {
  rubric: "var(--ok)",
  convention: "var(--text-secondary)",
  security: "var(--crit)",
  custom: "var(--text-muted)",
};
