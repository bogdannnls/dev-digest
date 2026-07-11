/**
 * ContextService — Project Context reader (L05 T1).
 *
 * Stateless, on-demand glob discovery over a repo's clone (Q1 in the design:
 * no new DB table; `reindex` just re-globs). Every read funnels through
 * `resolveClone` + `discoverMarkdownFiles`/`isPathInDiscoverySet` so there is
 * exactly ONE place that (a) decides a repo is "not cloned" and (b) decides a
 * path is safe to read — `listPaths` is that shared primitive; later tasks
 * (attach-time validation for agents/skills, the run-executor pre-flight)
 * reuse it rather than re-implementing discovery or path-safety.
 */
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { RepoRef, SpecFile } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError, RepoNotClonedError } from '../../platform/errors.js';
import { RepoRepository } from '../repos/repository.js';
import { discoverMarkdownFiles, isPathInDiscoverySet } from './helpers.js';

export class ContextService {
  private repos: RepoRepository;

  constructor(private container: Container) {
    this.repos = new RepoRepository(container.db);
  }

  /**
   * Freshly-discovered relative document paths for a repo, or `null` if the
   * repo row exists but has no clone on disk yet. This is the shared
   * whitelist primitive: T2/T3/T4 (agent/skill attach-time path validation,
   * run-executor pre-flight) call this instead of re-globbing or
   * re-implementing the not-cloned check. Do NOT duplicate that logic
   * elsewhere — extend this method if a caller needs something new from it.
   *
   * Throws `NotFoundError` if `repoId` doesn't resolve to a row in this
   * workspace — that is a different condition from "not cloned" (a
   * nonexistent repo vs. a real repo nobody has cloned yet).
   */
  async listPaths(workspaceId: string, repoId: string): Promise<Set<string> | null> {
    const resolved = await this.resolveClone(workspaceId, repoId);
    if (!resolved) return null;
    const files = await discoverMarkdownFiles(resolved.cloneRoot, this.container.config.contextRoots);
    return new Set(files);
  }

  /**
   * AC-1, AC-2, AC-4, AC-5: discovered documents for a repo — path, size,
   * updated_at — content always omitted here (Preview uses `readOne`).
   */
  async list(workspaceId: string, repoId: string): Promise<SpecFile[]> {
    const resolved = await this.resolveClone(workspaceId, repoId);
    if (!resolved) throw new RepoNotClonedError();
    const files = await discoverMarkdownFiles(resolved.cloneRoot, this.container.config.contextRoots);
    return this.toSpecFiles(resolved.cloneRoot, files);
  }

  /**
   * AC-6: re-run discovery against the clone's CURRENT state and return the
   * refreshed list. Stateless — identical to `list`, no DB row is written.
   */
  async reindex(workspaceId: string, repoId: string): Promise<SpecFile[]> {
    return this.list(workspaceId, repoId);
  }

  /**
   * AC-3, AC-34: a single document's content, ONLY if `path` is present in a
   * discovery pass run fresh against the CURRENT clone state (never trusted
   * from a prior call or from storage). `path` is checked by whitelist
   * membership alone — see `isPathInDiscoverySet` for why that is sufficient
   * to reject `../` traversal, absolute paths, and symlink-escape attempts.
   */
  async readOne(workspaceId: string, repoId: string, path: string): Promise<SpecFile> {
    const resolved = await this.resolveClone(workspaceId, repoId);
    if (!resolved) throw new RepoNotClonedError();
    const files = await discoverMarkdownFiles(resolved.cloneRoot, this.container.config.contextRoots);
    if (!isPathInDiscoverySet(path, files)) {
      throw new NotFoundError('Document not found in the current discovery set', { path });
    }
    // `path` passed the whitelist check above, but the file can still vanish
    // between discovery and read — a real race, e.g. a concurrent `resync`
    // running `git reset --hard` on this same clone. Map ANY fs error here to
    // a clean NotFoundError: never let a raw fs error (whose message embeds
    // the absolute clone path) reach app.ts's generic 500 handler, which
    // forwards `err.message` verbatim and would leak that path.
    try {
      const [content, st] = await Promise.all([
        this.container.git.readFile(resolved.ref, path),
        stat(join(resolved.cloneRoot, path)),
      ]);
      return { path, content, size: st.size, updated_at: st.mtime.toISOString() };
    } catch {
      throw new NotFoundError('Document not found', { path });
    }
  }

  /**
   * Resolve the repo row (tenant-scoped by `workspaceId`, guarding against
   * cross-workspace repoId enumeration) and its clone root. Returns `null`
   * when the row exists but nothing is cloned to disk yet — detected via
   * `fs.access` on `container.git.clonePathFor(...)`, NOT the row's nullable
   * `clonePath` column (written once at clone time; can go stale relative to
   * the real filesystem, e.g. if the clone dir was later removed).
   */
  private async resolveClone(
    workspaceId: string,
    repoId: string,
  ): Promise<{ ref: RepoRef; cloneRoot: string } | null> {
    const repo = await this.repos.getById(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    const ref: RepoRef = { owner: repo.owner, name: repo.name };
    const cloneRoot = this.container.git.clonePathFor(ref);

    // Defense-in-depth, independent of upstream owner/name validation: a
    // malicious `owner`/`name` segment (the repo-URL parser's regex allows
    // `.`, so `owner: '..'` is theoretically constructable) must never let
    // the resolved clone root escape the configured clone dir. Treat an
    // escape identically to "not cloned" — never discover/serve from it.
    const resolvedRoot = resolve(cloneRoot);
    const resolvedCloneDir = resolve(this.container.config.cloneDir);
    if (!resolvedRoot.startsWith(resolvedCloneDir + sep)) {
      return null;
    }

    const cloned = await access(cloneRoot, constants.F_OK).then(
      () => true,
      () => false,
    );
    if (!cloned) return null;
    return { ref, cloneRoot };
  }

  /** Stat each discovered path for its size + last-modified time (best-effort). */
  private async toSpecFiles(cloneRoot: string, files: string[]): Promise<SpecFile[]> {
    const out: SpecFile[] = [];
    for (const path of files) {
      const st = await stat(join(cloneRoot, path)).catch(() => null);
      out.push({ path, size: st?.size ?? null, updated_at: st?.mtime.toISOString() ?? null });
    }
    return out;
  }
}
