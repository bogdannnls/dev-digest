/**
 * Integration coverage for the Project Context reader (L05 T1):
 *   GET  /repos/:id/context
 *   GET  /repos/:id/context/file?path=
 *   POST /repos/:id/context/reindex
 *
 * `MockGitClient` (adapters/mocks.ts) is intentionally NOT used here —
 * `clonePathFor()` returns a synthetic `/mock/clones/...` path that does not
 * exist on disk, so it can't exercise real glob/symlink/traversal behavior.
 * Instead this file builds a small `GitClient`-shaped test double whose
 * `clonePathFor`/`readFile` point at a REAL `fs.mkdtemp` directory populated
 * with real files (including a symlink escaping it, for the AC-7 case).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  console.warn('[context-reader] Docker not available — skipping.');
}

/**
 * GitClient-shaped test double over a REAL directory on disk. Every method
 * besides `clonePathFor`/`readFile` is unused by the context reader but must
 * be implemented to satisfy the interface.
 */
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
}

/**
 * Simulates the discovery→read race a security review flagged: the file
 * vanishes (e.g. a concurrent `resync`'s `git reset --hard`) AFTER it passed
 * the freshly-run discovery whitelist but BEFORE `readFile` actually reads
 * it. Unlinking here forces `container.git.readFile` to hit a real ENOENT.
 */
class RaceConditionGitClient extends RealDirGitClient {
  async readFile(repo: RepoRef, path: string): Promise<string> {
    await rm(join(this.root, path), { force: true });
    return super.readFile(repo, path);
  }
}

d('Project Context reader (T1)', () => {
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
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
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

  function makeApp(git: GitClient, contextRoots?: string[]) {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      // RealDirGitClient/RaceConditionGitClient always resolve clonePathFor()
      // to a real fs.mkdtemp() dir created directly under the OS tmp dir
      // (see `tempDir()` above). `resolveClone`'s anchoring check (defense in
      // depth against an escaping owner/name segment) requires `cloneRoot` to
      // live inside `config.cloneDir` — true for the real SimpleGitClient by
      // construction, so anchor it here too, or every test double's
      // legitimate root would be (wrongly) rejected as "escaping".
      DEVDIGEST_CLONE_DIR: tmpdir(),
      ...(contextRoots ? { CONTEXT_ROOTS: contextRoots.join(',') } : {}),
    } as NodeJS.ProcessEnv;
    const config = loadConfig(env);
    return buildApp({ config, db: pg.handle.db, overrides: { git } });
  }

  it('discovers nested .md files under specs/docs/insights at any depth (AC-1)', async () => {
    const root = await tempDir('ctx-it-discover-');
    await mkdir(join(root, 'specs', 'nested'), { recursive: true });
    await writeFile(join(root, 'specs', 'top.md'), '# top');
    await writeFile(join(root, 'specs', 'nested', 'deep.md'), '# deep');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# guide');
    await mkdir(join(root, 'insights', 'sub'), { recursive: true });
    await writeFile(join(root, 'insights', 'sub', 'note.md'), '# note');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('discover-repo');

    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(res.statusCode).toBe(200);
    const paths = res.json().map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'specs/top.md',
        'specs/nested/deep.md',
        'docs/guide.md',
        'insights/sub/note.md',
      ]),
    );
    await app.close();
  });

  it('GET /repos/:id/context list response omits the content field (AC-2)', async () => {
    const root = await tempDir('ctx-it-nocontent-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('list-omits-content');

    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(res.statusCode).toBe(200);
    const [item] = res.json();
    expect(item.path).toBe('specs/a.md');
    expect(item).not.toHaveProperty('content');
    expect(typeof item.size).toBe('number');
    expect(typeof item.updated_at).toBe('string');
    await app.close();
  });

  it('GET /repos/:id/context/file?path= returns content for a discovered path (AC-3)', async () => {
    const root = await tempDir('ctx-it-file-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# hello world');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('file-endpoint');

    const res = await app.inject({
      method: 'GET',
      url: `/repos/${repoId}/context/file?path=specs/a.md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: 'specs/a.md', content: '# hello world' });
    await app.close();
  });

  it('context list distinguishes not-cloned from empty (AC-4)', async () => {
    const notClonedRoot = join(tmpdir(), `ctx-it-not-cloned-${Date.now()}-${Math.random()}`);
    const app = await makeApp(new RealDirGitClient(notClonedRoot));
    const repoId = await insertRepo('not-cloned-repo');

    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('repo_not_cloned');
    await app.close();
  });

  it('cloned repo with zero matching docs returns an empty list, not a not-cloned status (AC-5)', async () => {
    const root = await tempDir('ctx-it-empty-');
    await writeFile(join(root, 'README.md'), '# readme'); // cloned, but no specs/docs/insights dirs
    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('empty-repo');

    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('POST /repos/:id/context/reindex reflects a doc added after the prior list call, with no DB row written (AC-6)', async () => {
    const root = await tempDir('ctx-it-reindex-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('reindex-repo');

    const before = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(before.json().map((f: { path: string }) => f.path)).toEqual(['specs/a.md']);

    // A doc is added to the clone after the first list call.
    await writeFile(join(root, 'specs', 'b.md'), '# b');

    const after = await app.inject({ method: 'POST', url: `/repos/${repoId}/context/reindex` });
    expect(after.statusCode).toBe(200);
    expect(after.json().map((f: { path: string }) => f.path).sort()).toEqual([
      'specs/a.md',
      'specs/b.md',
    ]);

    // Stateless: reindex persists nothing — the repos row's clonePath (the
    // only column this feature could plausibly touch) stays exactly as
    // `insertRepo` left it (null; this test never calls the real clone job).
    const [row] = await pg.handle.db.select().from(t.repos).where(eq(t.repos.id, repoId));
    expect(row!.clonePath).toBeNull();
    await app.close();
  });

  it('symlink escaping the clone dir is not discovered (AC-7)', async () => {
    const root = await tempDir('ctx-it-symlink-');
    const outside = await tempDir('ctx-it-symlink-outside-');
    await writeFile(join(outside, 'secret.md'), '# secret');
    await mkdir(join(root, 'specs'), { recursive: true });
    await symlink(join(outside, 'secret.md'), join(root, 'specs', 'escape.md'));

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('symlink-repo');

    const list = await app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    // Even a direct request naming the escaping path must be rejected — it
    // was never in the freshly-discovered set, so the whitelist check fails.
    const file = await app.inject({
      method: 'GET',
      url: `/repos/${repoId}/context/file?path=specs/escape.md`,
    });
    expect(file.statusCode).toBe(404);
    await app.close();
  });

  it('a ../../.devdigest/secrets.json-shaped path is never read, at run time (AC-34)', async () => {
    const root = await tempDir('ctx-it-traversal-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const app = await makeApp(new RealDirGitClient(root));
    const repoId = await insertRepo('traversal-repo');

    const res = await app.inject({
      method: 'GET',
      url: `/repos/${repoId}/context/file?path=${encodeURIComponent(
        '../../.devdigest/secrets.json',
      )}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('changing configured roots changes the discovered set (AC-8)', async () => {
    const root = await tempDir('ctx-it-roots-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');
    await mkdir(join(root, 'notes'), { recursive: true });
    await writeFile(join(root, 'notes', 'b.md'), '# b');

    const repoId = await insertRepo('roots-repo');

    const defaultApp = await makeApp(new RealDirGitClient(root));
    const defaultRes = await defaultApp.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(defaultRes.json().map((f: { path: string }) => f.path)).toEqual(['specs/a.md']);
    await defaultApp.close();

    const customApp = await makeApp(new RealDirGitClient(root), ['notes']);
    const customRes = await customApp.inject({ method: 'GET', url: `/repos/${repoId}/context` });
    expect(customRes.json().map((f: { path: string }) => f.path)).toEqual(['notes/b.md']);
    await customApp.close();
  });

  it('a path that passes the whitelist but vanishes before read yields a clean NotFound, never a raw fs error (security fix)', async () => {
    const root = await tempDir('ctx-it-vanish-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const app = await makeApp(new RaceConditionGitClient(root));
    const repoId = await insertRepo('vanish-repo');

    const res = await app.inject({
      method: 'GET',
      url: `/repos/${repoId}/context/file?path=specs/a.md`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    // Must never leak the absolute clone path, or any fs-error shape, in the response body.
    expect(res.payload).not.toContain(root);
    expect(res.payload.toUpperCase()).not.toContain('ENOENT');
    await app.close();
  });

  it('a repo row with a malicious owner segment ("..") never reads outside the configured clone dir (defense-in-depth)', async () => {
    const cloneDir = await tempDir('ctx-it-clonedir-');
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DEVDIGEST_CLONE_DIR: cloneDir,
    } as NodeJS.ProcessEnv);

    // The REAL SimpleGitClient, so `clonePathFor` really does
    // `join(cloneDir, owner, name)` — RealDirGitClient's test-only shortcut
    // (a single fixed root) wouldn't exercise the anchoring check at all.
    const { SimpleGitClient } = await import('../src/adapters/git/simple-git.js');
    const git = new SimpleGitClient(config.cloneDir);

    const [row] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: '..', name: 'escape-repo', fullName: 'escape/escape-repo' })
      .returning();

    const app = await buildApp({ config, db: pg.handle.db, overrides: { git } });
    const res = await app.inject({ method: 'GET', url: `/repos/${row!.id}/context` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('repo_not_cloned');
    await app.close();
  });
});
