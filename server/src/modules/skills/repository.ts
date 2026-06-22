import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * Skills data-access. Owns the `skills` and `skill_versions` tables.
 * Workspace-scoped throughout. Routes only call this through `SkillsService`.
 */

export type SkillRow = typeof t.skills.$inferSelect;

export class SkillsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<SkillRow[]> {
    return this.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId))
      .orderBy(desc(t.skills.createdAt));
  }
}
