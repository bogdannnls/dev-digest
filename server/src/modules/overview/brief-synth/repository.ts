import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { PrWhyRiskBrief, RiskSeverity } from '@devdigest/shared';

/**
 * Return shape of the combined `synthesizeBrief` (T5, `synthesize.ts`) +
 * deterministic post-processing (T12, `postprocess.ts`) pipeline, per SPEC-02
 * §7/§10. Declared locally here rather than imported because neither module
 * has landed yet; once they exist, this type is structurally compatible and
 * can be replaced with an import without changing call sites (mirrors
 * `ExtractIntentResult` in `overview/intent/repository.ts`).
 */
export type BriefSynthUpsertResult = {
  dto: Pick<PrWhyRiskBrief, 'what' | 'why' | 'riskLevel' | 'risks' | 'reviewFocus'>;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
};

/**
 * Freshness key a row is computed against (write side). A qualifying review
 * is a required input to compute a brief at all (AC-16..18 — `not_ready`
 * when intent or review is missing), so `reviewId` is always a known string
 * at write time.
 */
export type BriefSynthUpsertKey = {
  headSha: string;
  reviewId: string;
  intentComputedAt: string;
};

/**
 * Repository-facing read view of a cached row's freshness key. Unlike
 * `BriefSynthUpsertKey` (write side), `reviewId` is nullable here: the
 * `pr_brief.review_id` FK is `onDelete: 'set null'`, and review deletion is
 * a real shipped feature (server/INSIGHTS.md, L1) — a brief computed against
 * a review that has since been deleted reads back with a null `reviewId`
 * even though it was a real string at write time. The wire contract's
 * `basedOn.reviewId` (`vendor/shared/contracts/brief-synth.ts`) stays
 * `z.string()` (non-null) — reconciling that against a null DB value when
 * serving an HTTP response is the service's (T6) concern; this repository
 * just reflects DB truth.
 */
export type BriefSynthBasedOn = {
  headSha: string;
  reviewId: string | null;
  intentComputedAt: string;
};

/** Repository-facing view of a `pr_brief` row, mapped to the wire DTO shape. */
export type BriefSynthRow = {
  prId: string;
  data: Omit<PrWhyRiskBrief, 'basedOn'>;
  basedOn: BriefSynthBasedOn;
};

/**
 * Thin Drizzle wrapper around the extended `pr_brief` table. No business
 * logic — freshness comparison and job orchestration live in
 * `BriefSynthService` (T6), mirroring `IntentRepository` (T4's stated pattern).
 */
export class BriefSynthRepository {
  constructor(private db: Db) {}

  async get(prId: string): Promise<BriefSynthRow | null> {
    const [row] = await this.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    if (!row) return null;

    // `model` is nullable only for pre-existing ghost rows (`pr_brief` had
    // zero consumers before this migration — see 0017_extend_pr_brief.sql).
    // Mirrors the same defensive guard in `IntentRepository.get()`: treat a
    // null-model row as a cache miss rather than returning a DTO with a
    // fabricated model string.
    if (row.model === null) return null;

    const json = row.json as Pick<PrWhyRiskBrief, 'what' | 'why' | 'risks' | 'reviewFocus'>;

    const data: Omit<PrWhyRiskBrief, 'basedOn'> = {
      what: json.what,
      why: json.why,
      riskLevel: row.riskLevel as RiskSeverity,
      risks: json.risks,
      reviewFocus: json.reviewFocus,
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
      data,
      basedOn: {
        headSha: row.headSha,
        reviewId: row.reviewId,
        intentComputedAt: row.intentComputedAt.toISOString(),
      },
    };
  }

  async upsert(
    prId: string,
    key: BriefSynthUpsertKey,
    result: BriefSynthUpsertResult,
  ): Promise<void> {
    const values = {
      prId,
      json: {
        what: result.dto.what,
        why: result.dto.why,
        risks: result.dto.risks,
        reviewFocus: result.dto.reviewFocus,
      },
      headSha: key.headSha,
      reviewId: key.reviewId,
      intentComputedAt: new Date(key.intentComputedAt),
      riskLevel: result.dto.riskLevel,
      model: result.model,
      promptTokens: result.tokensIn,
      completionTokens: result.tokensOut,
      costUsd: result.costUsd.toFixed(6),
      computedAt: new Date(),
    };

    await this.db
      .insert(t.prBrief)
      .values(values)
      .onConflictDoUpdate({
        target: t.prBrief.prId,
        // Every persisted column is listed explicitly (including `json`) so
        // a refresh always overwrites stale data — an omitted column here
        // would silently preserve the prior row's value on conflict (see
        // server/INSIGHTS.md 2026-06-23 `linkSkill`).
        set: {
          json: values.json,
          headSha: values.headSha,
          reviewId: values.reviewId,
          intentComputedAt: values.intentComputedAt,
          riskLevel: values.riskLevel,
          model: values.model,
          promptTokens: values.promptTokens,
          completionTokens: values.completionTokens,
          costUsd: values.costUsd,
          computedAt: values.computedAt,
        },
      });
  }
}
