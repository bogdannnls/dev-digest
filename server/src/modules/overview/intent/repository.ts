import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { IntentReferenceRow, RiskAreaIcon } from '../../../db/schema.js';
import type { IntentReferenceDto, PrIntentDto } from '../../../vendor/shared/contracts/brief.js';

/**
 * Return shape of `extractIntent` (T6, `server/src/modules/overview/intent/extract.ts`),
 * per spec §8.4. Declared locally here rather than imported because T6 has not landed yet;
 * once it exists, this type is structurally compatible and can be replaced with an import
 * without changing call sites.
 */
export type ExtractIntentResult = {
  dto: Pick<PrIntentDto, 'goal' | 'inScope' | 'outOfScope' | 'riskAreas'>;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
};

/** Freshness key a row was computed against — used by the service to detect drift. */
export type IntentUpsertKey = {
  headSha: string;
  bodyHash: string;
};

/** Repository-facing view of a `pr_intent` row, mapped to the wire DTO shape. */
export type IntentRow = {
  prId: string;
  headSha: string;
  bodyHash: string;
  data: PrIntentDto;
};

/** Maps a persisted `IntentReferenceRow` to the wire `IntentReferenceDto` — never leaks `bodyHash`/`error`. */
function toReferenceDto(row: IntentReferenceRow): IntentReferenceDto {
  return {
    kind: row.kind,
    id: row.id,
    status: row.status,
    bodyChars: row.bodyChars,
  };
}

/**
 * Thin Drizzle wrapper around `pr_intent`. No business logic — freshness
 * comparison and job orchestration live in `IntentService` (T8).
 */
export class IntentRepository {
  constructor(private db: Db) {}

  async get(prId: string): Promise<IntentRow | null> {
    const [row] = await this.db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
    if (!row) return null;

    // `model` is nullable only for pre-Slice-D ghost rows written by the old
    // (now-removed) 4-column `upsertIntent` path. Spec §16.2 confirms no such
    // rows exist in production today, but the guard is kept as a defensive
    // fallback: treat a null-model row as a cache miss rather than returning
    // a DTO with a fabricated model string.
    if (row.model === null) return null;

    const data: PrIntentDto = {
      goal: row.intent,
      inScope: row.inScope,
      outOfScope: row.outOfScope,
      riskAreas: row.riskAreas as { icon: RiskAreaIcon; label: string }[],
      references: (row.references as IntentReferenceRow[]).map(toReferenceDto),
      model: row.model,
      cost: {
        tokensIn: row.promptTokens,
        tokensOut: row.completionTokens,
        usd: Number(row.costUsd),
      },
      computedAt: row.computedAt.toISOString(),
    };

    return {
      prId: row.prId,
      headSha: row.headSha,
      bodyHash: row.bodyHash,
      data,
    };
  }

  async upsert(
    prId: string,
    key: IntentUpsertKey,
    result: ExtractIntentResult,
    references: IntentReferenceRow[],
  ): Promise<void> {
    const values = {
      prId,
      intent: result.dto.goal,
      inScope: result.dto.inScope,
      outOfScope: result.dto.outOfScope,
      headSha: key.headSha,
      bodyHash: key.bodyHash,
      references,
      riskAreas: result.dto.riskAreas,
      model: result.model,
      promptTokens: result.tokensIn,
      completionTokens: result.tokensOut,
      costUsd: result.costUsd.toFixed(6),
      computedAt: new Date(),
    };

    await this.db
      .insert(t.prIntent)
      .values(values)
      .onConflictDoUpdate({
        target: t.prIntent.prId,
        // Every column is listed explicitly (including `references` and
        // `riskAreas`) so a refresh always overwrites stale data — an
        // omitted column here would silently preserve the prior row's
        // value on conflict (see server/INSIGHTS.md 2026-06-23 `linkSkill`).
        set: {
          intent: values.intent,
          inScope: values.inScope,
          outOfScope: values.outOfScope,
          headSha: values.headSha,
          bodyHash: values.bodyHash,
          references: values.references,
          riskAreas: values.riskAreas,
          model: values.model,
          promptTokens: values.promptTokens,
          completionTokens: values.completionTokens,
          costUsd: values.costUsd,
          computedAt: values.computedAt,
        },
      });
  }
}
