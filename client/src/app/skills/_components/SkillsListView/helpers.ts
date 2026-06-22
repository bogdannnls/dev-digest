import type { Skill, SkillType } from "@devdigest/shared";

export function filterSkills(
  skills: Skill[],
  query: string,
  types: ReadonlySet<SkillType>,
): Skill[] {
  const q = query.trim().toLowerCase();
  return skills.filter((s) => {
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) {
      return false;
    }
    if (types.size > 0 && !types.has(s.type)) return false;
    return true;
  });
}
