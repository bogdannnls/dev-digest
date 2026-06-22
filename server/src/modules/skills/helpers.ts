import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
import type { SkillRow } from './repository.js';

export interface ContentChangePatch {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
}

/** True iff a patch changes a content field (name/description/type/body)
 *  relative to the existing row — a content change bumps the version and
 *  snapshots a skill_versions row. Toggling enabled returns false. */
export function isContentChange(
  existing: Pick<SkillRow, 'name' | 'description' | 'type' | 'body'>,
  patch: ContentChangePatch,
): boolean {
  return (
    (patch.name !== undefined && patch.name !== existing.name) ||
    (patch.description !== undefined && patch.description !== existing.description) ||
    (patch.type !== undefined && patch.type !== existing.type) ||
    (patch.body !== undefined && patch.body !== existing.body)
  );
}

/** Map a persisted skill row to the public `Skill` DTO. */
export function toSkillDto(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillType,
    source: row.source as SkillSource,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    evidence_files: row.evidenceFiles ?? null,
  };
}
