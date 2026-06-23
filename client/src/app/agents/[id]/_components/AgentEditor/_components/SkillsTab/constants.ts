import type { SkillType } from "@devdigest/shared";

/** Local duplicate of /skills's TYPE_BADGE_BG — duplicated by spec
 *  ("no cross-feature imports" / ui-architecture rule). */
export const TYPE_BADGE_BG: Record<SkillType, string> = {
  rubric: "var(--ok)",
  convention: "var(--text-secondary)",
  security: "var(--crit)",
  custom: "var(--text-muted)",
};
