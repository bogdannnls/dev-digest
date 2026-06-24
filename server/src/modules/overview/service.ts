import type { Container } from '../../platform/container.js';
import type { PrOverviewBriefResponse } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { OverviewRepository } from './repository.js';
import { aggregatePrBrief } from './brief/aggregate.js';

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
}
