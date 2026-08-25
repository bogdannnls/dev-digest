import type { SpecFile } from "@devdigest/shared";

/** Pure filter: keep documents whose path contains the (trimmed,
 *  case-insensitive) query as a substring. An empty/whitespace query
 *  returns the full list unchanged. Mirrors
 *  `skills/_components/SkillsListView/helpers.ts`'s `filterSkills`. */
export function filterContextFiles(files: SpecFile[], query: string): SpecFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => f.path.toLowerCase().includes(q));
}
