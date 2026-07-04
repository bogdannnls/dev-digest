import type { IntentReferenceRow } from '../../../db/schema/reviews.js';
import type { IntentReferenceDto } from '../../../vendor/shared/contracts/brief.js';

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

/**
 * Maps a reference row (persisted or transient — `CollectedReference` is a
 * structural superset of `IntentReferenceRow`) to the wire `IntentReferenceDto`.
 * The wire DTO intentionally drops `bodyHash`/`fetchedAt`/`error`/`body`; using
 * this helper makes that boundary explicit at every call site rather than
 * relying on Zod's default strip behavior during `PrIntentDto.parse`.
 */
export function toReferenceDto(r: IntentReferenceRow): IntentReferenceDto {
  return {
    kind: r.kind,
    id: r.id,
    status: r.status,
    bodyChars: r.bodyChars,
  };
}
