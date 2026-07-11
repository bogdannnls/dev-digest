import type { Container } from '../../platform/container.js';
import type { BlastRadius, PrOverviewBriefResponse } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { OverviewRepository } from './repository.js';
import { aggregatePrBrief } from './brief/aggregate.js';
import { projectBlastRadius } from './blast-radius/project.js';
import {
  BLAST_RADIUS_SUMMARY_SYSTEM_PROMPT,
  buildBlastRadiusSummaryPrompt,
} from './blast-radius/summary.js';
import { routeModel } from '../../platform/model-router.js';
import { withTimeout } from '../../platform/resilience.js';
import type { DegradedReason } from '../repo-intel/types.js';

// Best-effort risk summary: bounded well below the LLM adapters' own 180s
// idle-timeout default, since this runs on the synchronous blast-radius
// request path — a hung/slow provider must not stall the HTTP response.
const SUMMARY_TIMEOUT_MS = 15_000;
const SUMMARY_MAX_TOKENS = 200;

/**
 * Overview module — Slice A.
 * Orchestrates: load rows → aggregate → return. No cache. `getBrief` makes no
 * LLM call; `getBlastRadius` makes one best-effort, non-blocking LLM call
 * (the optional risk summary) — see `generateBlastRadiusSummary`.
 */
export class OverviewService {
  private repo: OverviewRepository;

  constructor(private container: Container) {
    this.repo = new OverviewRepository(container.db);
  }

  async getBrief(workspaceId: string, prId: string): Promise<PrOverviewBriefResponse> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const inputs = await this.repo.getBriefInputs(prId, (model, tIn, tOut) =>
      model ? this.container.priceBook.estimate(model, tIn, tOut) : null,
    );

    return aggregatePrBrief({ ...inputs, now: new Date() });
  }

  async getBlastRadius(workspaceId: string, prId: string): Promise<PrBlastRadiusResponse> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const files = await this.repo.getChangedFilePaths(prId);

    // A PR with no changed files (e.g. a merge commit) has no blast radius at all.
    // Short-circuit to a ready-empty response: the facade treats an empty input set
    // as the degraded `no_data` path, which the UI would otherwise render as
    // "index isn't built" — misdirecting the user to rebuild an already-built index.
    if (files.length === 0) {
      return { status: 'ready', data: { changed_symbols: [], downstream: [], summary: '' } };
    }

    const result = await this.container.repoIntel.getBlastRadius(pull.repoId, files);
    const data = projectBlastRadius(result);

    // Optional stretch: a one-paragraph LLM risk summary. Only attempted when
    // there is something to summarize — an empty changed-symbol set (e.g. the
    // degraded-empty path) makes no LLM call at all. Any failure (provider
    // misconfigured, timeout, throw) degrades to an empty summary; it must
    // NEVER fail the blast-radius request itself.
    if (data.changed_symbols.length > 0) {
      data.summary = await this.generateBlastRadiusSummary(workspaceId, data);
    }

    if (result.degraded === true) {
      return { status: 'degraded', reason: result.reason ?? 'no_data', data };
    }

    return { status: 'ready', data };
  }

  private async generateBlastRadiusSummary(
    workspaceId: string,
    data: BlastRadius,
  ): Promise<string> {
    try {
      const { provider } = await this.container.resolveFeatureModel(workspaceId, 'review_intent');
      // `routeModel`'s Provider type is 'openai' | 'anthropic' only, and its
      // 'summary' tier returns model ids ('claude-haiku-4-5' / 'gpt-4o-mini') that
      // are NOT valid OpenRouter slugs — routing an openrouter workspace through it
      // is a guaranteed dead round-trip (+warn) on every view. Skip the summary for
      // openrouter until the router grows an openrouter table; the map still renders.
      if (provider === 'openrouter') return '';
      const model = routeModel('summary', provider);
      const llm = await this.container.llm(provider);

      const result = await withTimeout(
        llm.complete({
          model,
          messages: [
            { role: 'system', content: BLAST_RADIUS_SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: buildBlastRadiusSummaryPrompt(data) },
          ],
          maxTokens: SUMMARY_MAX_TOKENS,
        }),
        SUMMARY_TIMEOUT_MS,
      );

      return result.text.trim();
    } catch (err) {
      // Silent-catch landmine (see server/INSIGHTS.md 2026-07-04): always log
      // at warn level so a misconfigured/failing provider is diagnosable
      // instead of surfacing only as "the summary is always empty".
      console.warn('[overview] blast-radius summary generation failed:', err);
      return '';
    }
  }
}

export type PrBlastRadiusResponse = {
  status: 'ready' | 'degraded';
  reason?: DegradedReason;
  data: BlastRadius;
};
