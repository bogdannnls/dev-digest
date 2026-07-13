import { and, desc, eq, inArray } from 'drizzle-orm';
import * as t from '../../db/schema.js';
import type { Db } from '../../db/client.js';

/**
 * The canonical "latest review per PR" definition — id + agentId of the
 * newest `kind = 'review'` row for a PR ('summary'-kind rows never qualify).
 *
 * Extracted here so `computeFindingsByPr` (`pulls/routes.ts` — PR list findings
 * column + PR detail findings) and `assembleBriefInput`
 * (`overview/brief-synth/assemble-input.ts` — SPEC-02 AC-11) both derive
 * "latest review" from the exact same query — neither ever re-derives an
 * independent definition. See server/INSIGHTS.md 2026-06-19 ("List + detail
 * share `computeFindingsByPr` for latest-review consistency").
 *
 * `agentId` is returned alongside `id` (not a second query) so a caller that
 * also needs the reviewing agent (e.g. to resolve attached-context paths)
 * reads it off the SAME row used to decide "latest" — never a second,
 * potentially-inconsistent lookup.
 */
export interface LatestReviewRow {
  id: string;
  agentId: string | null;
}

/** Batch form — one query for many PRs (list/detail endpoints). */
export async function latestReviewsByPr(db: Db, prIds: string[]): Promise<Map<string, LatestReviewRow>> {
  const out = new Map<string, LatestReviewRow>();
  if (prIds.length === 0) return out;

  const reviewRows = await db
    .select({ id: t.reviews.id, prId: t.reviews.prId, agentId: t.reviews.agentId })
    .from(t.reviews)
    .where(and(inArray(t.reviews.prId, prIds), eq(t.reviews.kind, 'review')))
    .orderBy(desc(t.reviews.createdAt));

  for (const rv of reviewRows) {
    if (!out.has(rv.prId)) out.set(rv.prId, { id: rv.id, agentId: rv.agentId });
  }
  return out;
}

/**
 * Single-PR convenience — delegates to the batch query above so a single-PR
 * caller (e.g. `assembleBriefInput`) never re-derives its own definition of
 * "latest review."
 */
export async function latestReviewForPr(db: Db, prId: string): Promise<LatestReviewRow | null> {
  const map = await latestReviewsByPr(db, [prId]);
  return map.get(prId) ?? null;
}
