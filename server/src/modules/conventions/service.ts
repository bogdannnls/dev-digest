import type { Container } from '../../platform/container.js';
import type { RunEventKind, Skill } from '@devdigest/shared';
import type { ConventionRow } from './repository.js';
import { ConventionsRepository } from './repository.js';
import { extractConventions } from './extractor.js';
import { SkillsService } from '../skills/service.js';
import { AgentsService } from '../agents/service.js';

export interface ConventionDto {
  id: string;
  category: string;
  rule: string;
  evidence_path: string | null;
  evidence_snippet: string | null;
  confidence: number | null;
  accepted: boolean;
  created_at: string;
}

function toDto(row: ConventionRow): ConventionDto {
  return {
    id: row.id,
    category: row.category,
    rule: row.rule,
    evidence_path: row.evidencePath ?? null,
    evidence_snippet: row.evidenceSnippet ?? null,
    confidence: row.confidence ?? null,
    accepted: row.accepted,
    created_at: row.createdAt.toISOString(),
  };
}

export class ConventionsService {
  private repo: ConventionsRepository;
  private skills: SkillsService;
  private agents: AgentsService;

  constructor(private container: Container) {
    this.repo = new ConventionsRepository(container.db);
    this.skills = new SkillsService(container);
    this.agents = new AgentsService(container);
  }

  /**
   * Fire-and-forget extraction. Returns the scanId immediately for SSE
   * subscription. The actual work runs in the background.
   */
  async startExtraction(
    workspaceId: string,
    repoId: string,
    repoRecord: { owner: string; name: string; defaultBranch: string },
  ): Promise<string> {
    const scanId = `conv:${repoId}`;

    void this.runExtraction(workspaceId, repoId, repoRecord, scanId).catch((err) => {
      this.container.runBus.publish(scanId, 'error', (err as Error).message);
      this.container.runBus.complete(scanId);
    });

    return scanId;
  }

  private async runExtraction(
    workspaceId: string,
    repoId: string,
    repoRecord: { owner: string; name: string; defaultBranch: string },
    scanId: string,
  ): Promise<void> {
    // Wipe previous scan results before inserting fresh ones.
    await this.repo.deleteByRepo(workspaceId, repoId);

    const emit = (type: RunEventKind, message: string, data?: unknown) =>
      this.container.runBus.publish(scanId, type, message, data);

    const candidates = await extractConventions(
      this.container,
      workspaceId,
      repoId,
      repoRecord,
      emit,
    );

    if (candidates.length > 0) {
      await this.repo.insertMany(
        candidates.map((c) => ({ ...c, workspaceId, repoId })),
      );
    }

    this.container.runBus.complete(scanId);
  }

  /**
   * List conventions for a repo, optionally filtered by acceptance status.
   *
   * Task-2 fix: `listByRepo` derives `scannedAt` from `candidates[0]`, which
   * returns null when filtering by `accepted: true` and all candidates are
   * pending. We fetch the real timestamp from an unfiltered call instead.
   */
  async list(
    workspaceId: string,
    repoId: string,
    opts?: { accepted?: boolean },
  ): Promise<{ candidates: ConventionDto[]; scanned_at: string | null }> {
    const [filtered, unfiltered] = await Promise.all([
      this.repo.listByRepo(workspaceId, repoId, opts),
      // Unfiltered fetch for the real scanned_at timestamp.
      opts?.accepted !== undefined
        ? this.repo.listByRepo(workspaceId, repoId)
        : Promise.resolve(null),
    ]);

    const scannedAt = unfiltered?.scannedAt ?? filtered.scannedAt;

    return {
      candidates: filtered.candidates.map(toDto),
      scanned_at: scannedAt,
    };
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { rule?: string; accepted?: boolean },
  ): Promise<ConventionDto | undefined> {
    const row = await this.repo.update(workspaceId, id, patch);
    return row ? toDto(row) : undefined;
  }

  /**
   * Convert accepted conventions into skills, one skill per category.
   * Optionally links the created skills to an agent.
   */
  async createSkillsFromConventions(
    workspaceId: string,
    repoId: string,
    repoSlug: string,
    agentId?: string,
  ): Promise<{ skills: Skill[] }> {
    const { candidates } = await this.repo.listByRepo(workspaceId, repoId, { accepted: true });
    if (candidates.length === 0) return { skills: [] };

    // Group by category so each skill covers one theme.
    const groups = new Map<string, ConventionRow[]>();
    for (const c of candidates) {
      const g = groups.get(c.category) ?? [];
      g.push(c);
      groups.set(c.category, g);
    }

    const createdSkills: Skill[] = [];

    for (const [category, items] of groups) {
      const body = buildSkillBody(category, repoSlug, items);
      const skill = await this.skills.create(workspaceId, {
        name: `${repoSlug}-${category}`,
        description: `${items.length} ${category} convention${items.length > 1 ? 's' : ''} from ${repoSlug}`,
        type: 'convention',
        source: 'extracted',
        body,
      });
      createdSkills.push(skill);
    }

    if (agentId) {
      for (const skill of createdSkills) {
        await this.agents.linkSkill(workspaceId, agentId, skill.id);
      }
    }

    return { skills: createdSkills };
  }
}

function buildSkillBody(category: string, repoSlug: string, items: ConventionRow[]): string {
  const lines = [
    `# ${category}`,
    '',
    `House conventions for \`${repoSlug}\`. Flag changes that violate any rule below and cite the offending \`file:line\`.`,
    '',
  ];
  for (const item of items) {
    lines.push(`## ${item.rule}`, '');
    if (item.evidencePath && item.evidenceSnippet) {
      lines.push(
        `Detected in \`${item.evidencePath}\`:`,
        '',
        '```',
        item.evidenceSnippet,
        '```',
        '',
      );
    }
  }
  return lines.join('\n');
}
