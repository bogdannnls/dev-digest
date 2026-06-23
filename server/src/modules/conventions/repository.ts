import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

export type ConventionRow = typeof t.conventions.$inferSelect;

export interface InsertConvention {
  workspaceId: string;
  repoId: string;
  category: string;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  evidenceStartLine: number | null;
  evidenceEndLine: number | null;
  confidence: number;
}

export class ConventionsRepository {
  constructor(private db: Db) {}

  async deleteByRepo(workspaceId: string, repoId: string): Promise<void> {
    await this.db
      .delete(t.conventions)
      .where(
        and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)),
      );
  }

  async insertMany(rows: InsertConvention[]): Promise<ConventionRow[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(t.conventions)
      .values(
        rows.map((r) => ({
          workspaceId: r.workspaceId,
          repoId: r.repoId,
          category: r.category,
          rule: r.rule,
          evidencePath: r.evidencePath,
          evidenceSnippet: r.evidenceSnippet,
          evidenceStartLine: r.evidenceStartLine,
          evidenceEndLine: r.evidenceEndLine,
          confidence: r.confidence,
        })),
      )
      .returning();
  }

  async listByRepo(
    workspaceId: string,
    repoId: string,
    opts?: { accepted?: boolean },
  ): Promise<{ candidates: ConventionRow[]; scannedAt: string | null }> {
    const conditions = [
      eq(t.conventions.workspaceId, workspaceId),
      eq(t.conventions.repoId, repoId),
      ...(opts?.accepted !== undefined ? [eq(t.conventions.accepted, opts.accepted)] : []),
    ];

    const candidates = await this.db
      .select()
      .from(t.conventions)
      .where(and(...conditions))
      .orderBy(desc(t.conventions.createdAt));

    const scannedAt = candidates[0]?.createdAt?.toISOString() ?? null;
    return { candidates, scannedAt };
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { rule?: string; accepted?: boolean },
  ): Promise<ConventionRow | undefined> {
    const [row] = await this.db
      .update(t.conventions)
      .set({
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(patch.accepted !== undefined ? { accepted: patch.accepted } : {}),
      })
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.id, id)))
      .returning();
    return row;
  }
}
