import type { Container } from '../../platform/container.js';
import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
import { ValidationError } from '../../platform/errors.js';
import { SkillsRepository } from './repository.js';
import { parseSkillMarkdown, toSkillDto, type ParsedImportPayload } from './helpers.js';

export type { ParsedImportPayload } from './helpers.js';

/**
 * Skills service. Workspace-scoped facade over the repository.
 * Used by `routes.ts`; no other module imports this directly.
 */

export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
  attached_context_paths?: string[];
}

/**
 * AC-13: dedupe a submitted attached-document path list, keeping only each
 * path's first occurrence and preserving the order of first appearance.
 * Mirrors `agents/helpers.ts`'s `dedupeFirstOccurrence` — kept as a local,
 * unexported copy here rather than importing across the agents/skills module
 * boundary (no such cross-module dependency exists elsewhere in this codebase).
 */
function dedupeFirstOccurrence(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export class SkillsService {
  private repo: SkillsRepository;

  constructor(private container: Container) {
    this.repo = new SkillsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }

  async get(workspaceId: string, id: string): Promise<Skill | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toSkillDto(row) : undefined;
  }

  async create(workspaceId: string, input: CreateSkillInput): Promise<Skill> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      type: input.type,
      body: input.body,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    });
    return toSkillDto(row);
  }

  /**
   * `contextRepoId` is the transient, never-persisted "governing repo" (AC-12c
   * — the workspace's currently-active repo selection at save time, supplied
   * by the route from `UpdateSkillBody.repo_id`) used ONLY to validate
   * `patch.attached_context_paths` against a freshly-computed discovery set.
   * It is not part of `UpdateSkillInput`/the DB and must be provided whenever
   * `patch.attached_context_paths` is present (enforced by the route's Zod
   * `.refine()`; re-checked here so a direct service caller can't skip it).
   *
   * NOTE — no versioning: unlike agents, a skill's `attached_context_paths`
   * change never bumps `version` / writes a `skill_versions` row. Skills
   * version only on content changes (name/description/type/body), per the
   * L05 spec's "Versioning (agent only)".
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkillInput,
    contextRepoId?: string,
  ): Promise<Skill | undefined> {
    let attachedContextPaths: string[] | undefined;
    if (patch.attached_context_paths !== undefined) {
      if (!contextRepoId) {
        throw new ValidationError('repo_id is required when attached_context_paths is present');
      }
      const deduped = dedupeFirstOccurrence(patch.attached_context_paths);
      // AC-33: only ever trust a path that appears in a discovery pass run
      // FRESH against the repo's current clone state — never storage alone.
      // A repo with no clone yet (`listPaths` → null) has no known paths, so
      // any non-empty submitted list is rejected the same way an unknown path
      // would be.
      const known = (await this.container.context.listPaths(workspaceId, contextRepoId)) ?? new Set<string>();
      const unknown = deduped.filter((p) => !known.has(p));
      if (unknown.length > 0) {
        throw new ValidationError('Unknown attached document path(s)', { paths: unknown });
      }
      attachedContextPaths = deduped;
    }

    const row = await this.repo.update(workspaceId, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(attachedContextPaths !== undefined ? { attachedContextPaths } : {}),
    });
    return row ? toSkillDto(row) : undefined;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  parseImport(text: string, filename: string | undefined): ParsedImportPayload {
    return parseSkillMarkdown(text, filename);
  }

  async usage(
    workspaceId: string,
    id: string,
  ): Promise<{ agent_count: number } | undefined> {
    const u = await this.repo.usage(workspaceId, id);
    return u ? { agent_count: u.agentCount } : undefined;
  }
}
