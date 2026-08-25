/**
 * Integration coverage for L05 T3 — `attached_context_paths` storage + save-time
 * validation on `PUT /skills/:id` (AC-10, AC-11, AC-12, AC-12c, AC-13), and the
 * "skills version only on content change" invariant (skills do NOT bump version
 * or write a `skill_versions` row when only `attached_context_paths` changes —
 * unlike agents, see the L05 spec's "Versioning (agent only)").
 *
 * `MockGitClient` is intentionally NOT used — save-time validation calls
 * `container.context.listPaths`, which needs a REAL clone directory to glob
 * against (see `context-reader.it.test.ts`'s docstring for why). This file
 * reuses the same `RealDirGitClient` pattern as
 * `agents-context-paths.it.test.ts`, anchoring the clone root under
 * `config.cloneDir` (`DEVDIGEST_CLONE_DIR`) so the reader's defense-in-depth
 * "resolved root must live under cloneDir" check doesn't treat it as
 * not-cloned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type {
  GitClient,
  RepoRef,
  CloneOptions,
  UnifiedDiff,
  BlameLine,
  GitCommit,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills-context-paths] Docker not available — skipping integration tests.');
}

/** Directories `walkFiles` never descends into — mirrors `SimpleGitClient`'s ignore set. */
const WALK_IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

/**
 * Symlink-safe recursive walk over a real directory, mirroring
 * `SimpleGitClient.walkFiles`: `readdir(dir, { withFileTypes: true })` +
 * `Dirent.isDirectory()/isFile()` (the entry's OWN type) never follows a
 * symlink. Returns clone-relative, posix-style paths.
 */
async function walkInto(root: string, dir: string, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (WALK_IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkInto(root, full, acc);
    } else if (entry.isFile()) {
      acc.push(relative(root, full).split(sep).join('/'));
    }
  }
}

/** GitClient-shaped test double over a REAL directory on disk (mirrors context-reader.it.test.ts). */
class RealDirGitClient implements GitClient {
  constructor(protected root: string) {}
  clonePathFor(_repo: RepoRef): string {
    return this.root;
  }
  async clone(_repo: RepoRef, _url: string, _opts?: CloneOptions): Promise<{ path: string }> {
    return { path: this.root };
  }
  async fetchPullHead(): Promise<void> {}
  async sync(): Promise<{ head: string }> {
    return { head: 'HEAD' };
  }
  async currentHead(): Promise<string> {
    return 'HEAD';
  }
  async diff(): Promise<UnifiedDiff> {
    return { raw: '', files: [] };
  }
  async diffNameOnly(): Promise<string[]> {
    return [];
  }
  async blame(): Promise<BlameLine[]> {
    return [];
  }
  async log(): Promise<GitCommit[]> {
    return [];
  }
  async readFile(_repo: RepoRef, path: string): Promise<string> {
    return readFile(join(this.root, path), 'utf8');
  }
  async cloneExists(): Promise<boolean> {
    return access(this.root, constants.F_OK).then(
      () => true,
      () => false,
    );
  }
  async statFile(_repo: RepoRef, relPath: string): Promise<{ size: number; mtime: Date } | null> {
    try {
      const st = await stat(join(this.root, relPath));
      return { size: st.size, mtime: st.mtime };
    } catch {
      return null;
    }
  }
  async walkFiles(): Promise<string[]> {
    const acc: string[] = [];
    await walkInto(this.root, this.root, acc);
    return acc;
  }
}

d('PUT /skills/:id — attached_context_paths (L05 T3)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await pg?.stop();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function insertRepo(name: string): Promise<string> {
    const [row] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    return row!.id;
  }

  function makeApp(git: GitClient) {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      // Anchor the test double's clone root under config.cloneDir — see
      // context-reader.it.test.ts's makeApp docstring for why this matters.
      DEVDIGEST_CLONE_DIR: tmpdir(),
    } as NodeJS.ProcessEnv;
    const config = loadConfig(env);
    return buildApp({ config, db: pg.handle.db, overrides: { git } });
  }

  const createBody = {
    name: 'Context-aware Skill',
    type: 'custom' as const,
    body: 'Always check for X before merging.',
  };

  it('PUT persists attached_context_paths in submitted order (AC-10)', async () => {
    const root = await tempDir('sctx-persist-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');
    await writeFile(join(root, 'specs', 'b.md'), '# b');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('persist-repo');
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: { attached_context_paths: ['specs/b.md', 'specs/a.md'], repo_id: repoId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attached_context_paths).toEqual(['specs/b.md', 'specs/a.md']);

    const fetched = await app.inject({ method: 'GET', url: `/skills/${skillId}` });
    expect(fetched.json().attached_context_paths).toEqual(['specs/b.md', 'specs/a.md']);
    await app.close();
  });

  it('order is defined solely by array index and membership solely by presence — no separate field (AC-11)', async () => {
    const root = await tempDir('sctx-order-');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'x.md'), '# x');
    await writeFile(join(root, 'docs', 'y.md'), '# y');
    await writeFile(join(root, 'docs', 'z.md'), '# z');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('order-repo');
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: {
        attached_context_paths: ['docs/z.md', 'docs/x.md', 'docs/y.md'],
        repo_id: repoId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Order = array index: reordering below must be observable purely from
    // index position, with no sibling "order"/"membership" field on the DTO.
    expect(body.attached_context_paths).toEqual(['docs/z.md', 'docs/x.md', 'docs/y.md']);
    expect(body).not.toHaveProperty('attached_context_order');
    expect(body).not.toHaveProperty('attached_context_membership');
    await app.close();
  });

  it('rejects an unknown path with 422 naming that path, validated against repo_id (AC-12, AC-12c)', async () => {
    const root = await tempDir('sctx-unknown-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'known.md'), '# known');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('unknown-repo');
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: {
        attached_context_paths: ['specs/known.md', 'specs/does-not-exist.md'],
        repo_id: repoId,
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.paths).toEqual(['specs/does-not-exist.md']);

    // The save must not have partially applied.
    const fetched = await app.inject({ method: 'GET', url: `/skills/${skillId}` });
    expect(fetched.json().attached_context_paths).toBeFalsy();
    await app.close();
  });

  it('a ../ traversal path is rejected the same way an unknown path is (AC-12, AC-34)', async () => {
    const root = await tempDir('sctx-traversal-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('traversal-repo');
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: {
        attached_context_paths: ['../../.devdigest/secrets.json'],
        repo_id: repoId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.paths).toEqual(['../../.devdigest/secrets.json']);
    await app.close();
  });

  it('rejects the save when attached_context_paths is present without repo_id (AC-12c)', async () => {
    const app = await makeApp(new RealDirGitClient(await tempDir('sctx-norepo-')));
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: { attached_context_paths: ['specs/a.md'] },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('dedupes a repeated path, keeping its first position (AC-13)', async () => {
    const root = await tempDir('sctx-dedupe-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');
    await writeFile(join(root, 'specs', 'b.md'), '# b');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('dedupe-repo');
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: {
        attached_context_paths: ['specs/a.md', 'specs/b.md', 'specs/a.md'],
        repo_id: repoId,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attached_context_paths).toEqual(['specs/a.md', 'specs/b.md']);
    await app.close();
  });

  it('a path-only change does NOT bump the skill version or write a skill_versions row (unlike agents)', async () => {
    const root = await tempDir('sctx-noversion-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('noversion-repo');
    const created = await app.inject({ method: 'POST', url: '/skills', payload: createBody });
    const skillId = created.json().id as string;
    expect(created.json().version).toBe(1);

    const rowsBefore = await pg.handle.db
      .select()
      .from(t.skillVersions)
      .where(eq(t.skillVersions.skillId, skillId));
    expect(rowsBefore).toHaveLength(1);

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: { attached_context_paths: ['specs/a.md'], repo_id: repoId },
    });
    expect(res.statusCode).toBe(200);
    // Version unchanged — a path-only change is not a "content" change for
    // skills (name/description/type/body only).
    expect(res.json().version).toBe(1);

    const rowsAfter = await pg.handle.db
      .select()
      .from(t.skillVersions)
      .where(eq(t.skillVersions.skillId, skillId));
    // No new skill_versions row was written for the path-only change.
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter).toEqual(rowsBefore);
    await app.close();
  });
});
