import type { IntentReferenceRow } from '../../../db/schema/reviews.js';

/**
 * In-memory transient shape returned by `collectReferences` and consumed by
 * `extractIntent`. Extends the persisted row shape with the raw fetched text
 * so the extractor can inline it into `<external_reference>` prompt blocks.
 * The service strips `body` before calling `IntentRepository.upsert` — the
 * persisted row keeps only `bodyHash` + `bodyChars` (spec §6.3).
 */
export type CollectedReference = IntentReferenceRow & {
  body: string | null;
};

export function toReferenceRow(r: CollectedReference): IntentReferenceRow {
  const { body: _body, ...row } = r;
  return row;
}
