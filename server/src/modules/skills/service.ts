import type { Container } from '../../platform/container.js';
import type { Skill } from '@devdigest/shared';
import { SkillsRepository } from './repository.js';
import { toSkillDto } from './helpers.js';

/**
 * Skills service. Workspace-scoped facade over the repository.
 * Used by `routes.ts`; no other module imports this directly.
 */
export class SkillsService {
  private repo: SkillsRepository;

  constructor(container: Container) {
    this.repo = new SkillsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }
}
