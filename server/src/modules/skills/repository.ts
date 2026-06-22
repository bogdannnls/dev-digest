import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SkillSource, SkillType } from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';
import { DEFAULT_SKILL_DESCRIPTION, INITIAL_SKILL_VERSION } from './constants.js';
import { isContentChange } from './helpers.js';

/**
 * Skills data-access. Owns the `skills` and `skill_versions` tables.
 * Workspace-scoped throughout. Routes only call this through `SkillsService`.
 */

export type SkillRow = typeof t.skills.$inferSelect;

export interface InsertSkill {
  workspaceId: string;
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
  evidenceFiles?: string[] | null;
}

export interface UpdateSkill {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
}

export class SkillsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<SkillRow[]> {
    return this.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId))
      .orderBy(desc(t.skills.createdAt));
  }

  async getById(workspaceId: string, id: string): Promise<SkillRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)));
    return row;
  }

  async insert(values: InsertSkill): Promise<SkillRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t.skills)
        .values({
          workspaceId: values.workspaceId,
          name: values.name,
          description: values.description ?? DEFAULT_SKILL_DESCRIPTION,
          type: values.type,
          body: values.body,
          enabled: values.enabled ?? true,
          source: values.source ?? 'manual',
          version: INITIAL_SKILL_VERSION,
          evidenceFiles: values.evidenceFiles ?? null,
        })
        .returning();
      if (!row) {
        throw new AppError('skill_insert_failed', 'unexpected empty insert', 500);
      }
      await tx.insert(t.skillVersions).values({
        skillId: row.id,
        version: INITIAL_SKILL_VERSION,
        body: row.body,
      });
      return row;
    });
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkill,
  ): Promise<SkillRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(t.skills)
        .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
        .limit(1);
      if (!existing) return undefined;

      const contentChanged = isContentChange(existing, patch);
      const nextVersion = contentChanged ? existing.version + 1 : existing.version;

      const [row] = await tx
        .update(t.skills)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(contentChanged ? { version: nextVersion } : {}),
        })
        .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
        .returning();

      if (contentChanged && row) {
        await tx.insert(t.skillVersions).values({
          skillId: row.id,
          version: nextVersion,
          body: row.body,
        });
      }
      return row;
    });
  }
}
