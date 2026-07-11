import type { Container } from '../../platform/container.js';
import type {
  Agent,
  AgentSkillLink,
  AgentVersion,
  CiFailOn,
  ModelInfo,
  Provider,
  ReviewStrategy,
} from '@devdigest/shared';
import { reviewPullRequest } from '@devdigest/reviewer-core';
import { NotFoundError } from '../../platform/errors.js';
import type { SkillsEvalResult, SkillsEvalSide } from '../../vendor/shared/contracts/knowledge.js';
import { loadFixture } from './eval-fixtures.js';
import { AgentsRepository } from './repository.js';
import { toAgentDto, toAgentVersionDto } from './helpers.js';

/**
 * A2 — agents service. Business logic for the Agents tab + Agent Editor.
 * Provider/model selection uses the LLM adapter's dynamic model list.
 *
 * An Agent = provider + model + system_prompt + linked skills + output_schema +
 * enabled. Config changes are versioned via `agent_versions` (repository).
 */

// Re-exported for backwards compatibility; implementation lives in ./helpers.
export { toAgentDto } from './helpers.js';

export interface CreateAgentInput {
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  system_prompt: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  enabled?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  system_prompt?: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  enabled?: boolean;
}

export class AgentsService {
  private repo: AgentsRepository;

  constructor(private container: Container) {
    this.repo = new AgentsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Agent[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toAgentDto);
  }

  async get(workspaceId: string, id: string): Promise<Agent | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toAgentDto(row) : undefined;
  }

  /** Delete an agent (and its versions/skill-links, via cascade). */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  async create(workspaceId: string, input: CreateAgentInput, userId?: string): Promise<Agent> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.system_prompt,
      outputSchema: input.output_schema,
      ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
      ...(input.ci_fail_on !== undefined ? { ciFailOn: input.ci_fail_on } : {}),
      ...(input.repo_intel !== undefined ? { repoIntel: input.repo_intel } : {}),
      enabled: input.enabled,
      createdBy: userId ?? null,
    });
    return toAgentDto(row);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgentInput,
  ): Promise<Agent | undefined> {
    const row = await this.repo.update(workspaceId, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.system_prompt !== undefined ? { systemPrompt: patch.system_prompt } : {}),
      ...(patch.output_schema !== undefined ? { outputSchema: patch.output_schema } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
      ...(patch.ci_fail_on !== undefined ? { ciFailOn: patch.ci_fail_on } : {}),
      ...(patch.repo_intel !== undefined ? { repoIntel: patch.repo_intel } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    return row ? toAgentDto(row) : undefined;
  }

  /**
   * Config history for an agent, newest version first. Workspace-scoped: returns
   * undefined when the agent isn't in this workspace (the route maps that to 404)
   * so version snapshots can't be read across tenants.
   */
  async listVersions(workspaceId: string, agentId: string): Promise<AgentVersion[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const rows = await this.repo.listVersions(agentId);
    return rows.map(toAgentVersionDto);
  }

  /**
   * A single config snapshot for an agent. Returns undefined when the agent isn't
   * in this workspace OR that version was never recorded (route → 404).
   */
  async getVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersion | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const row = await this.repo.getVersion(agentId, version);
    return row ? toAgentVersionDto(row) : undefined;
  }

  /** Linked skills for an agent as AgentSkillLink[] (ordered). */
  async skillLinks(agentId: string): Promise<AgentSkillLink[]> {
    const links = await this.repo.linkedSkills(agentId);
    return links.map((l) => ({
      agent_id: agentId,
      skill_id: l.skill.id,
      order: l.order,
      enabled: l.enabled,
    }));
  }

  /**
   * Set / reorder the agent's linked skills. If `skillIds` is provided, replaces
   * the whole set in that order. Returns the resulting ordered links.
   */
  async setSkills(
    workspaceId: string,
    agentId: string,
    skillIds: string[],
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    await this.repo.setSkills(agentId, skillIds);
    return this.skillLinks(agentId);
  }

  /** Link a single skill (append or set order) — additive to existing links. */
  async linkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
    order?: number,
    enabled?: boolean,
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const existing = await this.repo.linkedSkills(agentId);
    const resolvedOrder = order ?? existing.length;
    await this.repo.linkSkill(agentId, skillId, resolvedOrder, enabled);
    return this.skillLinks(agentId);
  }

  /**
   * Toggle the enabled flag on a single link. Returns the updated ordered link
   * list, or undefined if the agent is missing in this workspace OR no link
   * exists for (agentId, skillId).
   */
  async setSkillEnabled(
    workspaceId: string,
    agentId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const updated = await this.repo.setSkillEnabled(agentId, skillId, enabled);
    if (!updated) return undefined;
    return this.skillLinks(agentId);
  }

  /**
   * Unlink a single skill from an agent. Returns the updated link list (possibly
   * empty), or undefined if the agent is missing in this workspace.
   */
  async unlinkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    await this.repo.unlinkSkill(agentId, skillId);
    return this.skillLinks(agentId);
  }

  /**
   * A/B eval: runs reviewPullRequest twice against a packaged fixture — once with
   * the agent's enabled skills, once without — so callers can compare quality.
   *
   * Returns undefined when the agent is missing in this workspace (route → 404).
   * Throws NotFoundError when the fixture id is unknown (also surfaces as 404, but
   * with a more specific message so the distinction is logged server-side).
   *
   * The two runs are sequential — provider rate limits preclude parallelism.
   */
  async evaluateSkillsAB(
    workspaceId: string,
    agentId: string,
    fixtureId: string,
  ): Promise<SkillsEvalResult | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;

    const fx = loadFixture(fixtureId);
    if (!fx) throw new NotFoundError(`Fixture "${fixtureId}" not found`);

    const skillBodies = await this.repo.enabledSkillBodiesForAgent(agentId);
    const llm = await this.container.llm(agent.provider as Provider);

    const runOnce = async (skills: string[] | undefined): Promise<SkillsEvalSide> => {
      const outcome = await reviewPullRequest({
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        diff: fx.unifiedDiff,
        llm,
        strategy: agent.strategy ?? 'auto',
        ...(skills && skills.length > 0 ? { skills } : {}),
        task: `Skills A/B eval · ${fx.meta.title}`,
        sessionId: `skills-eval:${agentId}:${fixtureId}`,
      });
      return {
        findings: outcome.review.findings,
        grounding: outcome.grounding,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costUsd: outcome.costUsd,
      };
    };

    const with_skills = await runOnce(skillBodies);
    const without_skills = await runOnce([]);

    return { with_skills, without_skills, fixture: fx.meta };
  }

  /**
   * Dynamic model list from the provider adapter's /models. Throws when the
   * provider isn't configured or the upstream call fails; the route layer is
   * responsible for logging and degrading to [] so the editor still renders.
   * (Silent-catch here previously hid a real SDK Gunzip failure — see
   * server/INSIGHTS.md 2026-07-04.)
   */
  async listModels(provider: Provider): Promise<ModelInfo[]> {
    const llm = await this.container.llm(provider);
    return llm.listModels();
  }
}
