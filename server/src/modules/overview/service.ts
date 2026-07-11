import type { Container } from '../../platform/container.js';
import type { BlastRadius, PrOverviewBriefResponse } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { OverviewRepository } from './repository.js';
import { aggregatePrBrief } from './brief/aggregate.js';
import { projectBlastRadius } from './blast-radius/project.js';
import type { DegradedReason } from '../repo-intel/types.js';

/**
 * Overview module — Slice A.
 * Orchestrates: load rows → aggregate → return. No cache, no LLM.
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
    const result = await this.container.repoIntel.getBlastRadius(pull.repoId, files);

    if (result.degraded === true) {
      return {
        status: 'degraded',
        reason: result.reason ?? 'no_data',
        data: projectBlastRadius(result),
      };
    }

    return { status: 'ready', data: projectBlastRadius(result) };
  }
}

export type PrBlastRadiusResponse = {
  status: 'ready' | 'degraded';
  reason?: DegradedReason;
  data: BlastRadius;
};
