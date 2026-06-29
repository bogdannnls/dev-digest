import type {
  AgentSkillLink,
  Skill,
  SkillSource,
  SkillType,
} from '@devdigest/shared';

/**
 * Cross-module ports — interfaces that one module exposes for another to
 * consume without importing concrete services across module boundaries.
 *
 * Wired through `platform/container.ts` (the composition root). The container
 * is the only place that knows the concrete implementations.
 */

export interface CreateSkillPortInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
}

export interface SkillsPort {
  create(workspaceId: string, input: CreateSkillPortInput): Promise<Skill>;
}

export interface AgentsPort {
  linkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
    order?: number,
    enabled?: boolean,
  ): Promise<AgentSkillLink[] | undefined>;
}
