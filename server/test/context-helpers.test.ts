/**
 * Unit tests (no Docker) for the Project Context discovery helpers.
 *
 * `discoverMarkdownFiles`/`isPathInDiscoverySet` (`src/modules/context/helpers.ts`)
 * are pure functions over an already-walked file list — no filesystem access
 * (onion MUST.2: the walk itself lives on `GitClient.walkFiles`).
 *
 * The symlink-safe recursive walk is exercised here directly against
 * `SimpleGitClient.walkFiles` (real `fs.mkdtemp` directories, no Docker/DB
 * needed — `SimpleGitClient` is a plain adapter class).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMarkdownFiles, isPathInDiscoverySet } from '../src/modules/context/helpers.js';
import { SimpleGitClient } from '../src/adapters/git/simple-git.js';

describe('modules/context/helpers', () => {
  const repo = { owner: 'ctx-helpers', name: 'repo' };
  let git: SimpleGitClient;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const cloneDir = await mkdtemp(join(tmpdir(), 'ctx-helpers-clonedir-'));
    git = new SimpleGitClient(cloneDir);
    root = git.clonePathFor(repo);
    await mkdir(root, { recursive: true });
    outside = await mkdtemp(join(tmpdir(), 'ctx-helpers-outside-'));

    // specs/ (nested), docs/, insights/ — the default discovery roots.
    await mkdir(join(root, 'specs', 'nested'), { recursive: true });
    await writeFile(join(root, 'specs', 'top.md'), '# top');
    await writeFile(join(root, 'specs', 'nested', 'deep.md'), '# deep');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# guide');
    await mkdir(join(root, 'insights'), { recursive: true });
    await writeFile(join(root, 'insights', 'note.md'), '# note');

    // Not under any configured root — must be excluded.
    await writeFile(join(root, 'README.md'), '# root readme');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export {}');

    // Ignored directories — must never be descended into.
    await mkdir(join(root, 'node_modules', 'specs'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'specs', 'ignored.md'), '# ignored');
    await mkdir(join(root, '.git', 'specs'), { recursive: true });
    await writeFile(join(root, '.git', 'specs', 'ignored.md'), '# ignored');

    // A file genuinely outside the walked root, to prove nothing leaks it.
    await writeFile(join(outside, 'secret.md'), '# secret');
    // Symlink (file) under specs/ escaping the clone root.
    await symlink(join(outside, 'secret.md'), join(root, 'specs', 'escape.md'));
    // Symlink (directory) under docs/ escaping the clone root.
    await symlink(outside, join(root, 'docs', 'escaped-dir'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('SimpleGitClient.walkFiles', () => {
    it('collects files recursively and never descends into ignored dirs', async () => {
      const files = await git.walkFiles(repo);
      expect(files.some((f) => f.split('/').includes('node_modules'))).toBe(false);
      expect(files.some((f) => f.split('/').includes('.git'))).toBe(false);
      expect(files).toContain('src/index.ts');
    });

    it('never follows a symlink — file or directory, escaping or not', async () => {
      const files = await git.walkFiles(repo);
      expect(files.some((f) => f.endsWith('escape.md'))).toBe(false);
      expect(files.some((f) => f.includes('escaped-dir'))).toBe(false);
      expect(files.some((f) => f.endsWith('secret.md'))).toBe(false);
    });
  });

  describe('discoverMarkdownFiles', () => {
    it('finds nested .md files under specs/docs/insights at any depth (AC-1)', async () => {
      const walked = await git.walkFiles(repo);
      const found = discoverMarkdownFiles(walked, ['specs', 'docs', 'insights']);
      expect(found).toEqual(
        expect.arrayContaining([
          'specs/top.md',
          'specs/nested/deep.md',
          'docs/guide.md',
          'insights/note.md',
        ]),
      );
    });

    it('excludes .md files not under a configured root', async () => {
      const walked = await git.walkFiles(repo);
      const found = discoverMarkdownFiles(walked, ['specs', 'docs', 'insights']);
      expect(found).not.toContain('README.md');
    });

    it('excludes a symlink escaping the clone dir, even placed under a matching root (AC-7)', async () => {
      const walked = await git.walkFiles(repo);
      const found = discoverMarkdownFiles(walked, ['specs', 'docs', 'insights']);
      expect(found).not.toContain('specs/escape.md');
      expect(found.some((f) => f.includes('escaped-dir'))).toBe(false);
      expect(found.some((f) => f.includes('secret'))).toBe(false);
    });

    it('never descends into node_modules/.git even when they contain a same-named root dir', async () => {
      const walked = await git.walkFiles(repo);
      const found = discoverMarkdownFiles(walked, ['specs', 'docs', 'insights']);
      expect(found.some((f) => f.includes('node_modules'))).toBe(false);
      expect(found.some((f) => f.includes('.git'))).toBe(false);
    });

    it('changing configured roots changes the discovered set (AC-8)', async () => {
      const walked = await git.walkFiles(repo);
      const onlyDocs = discoverMarkdownFiles(walked, ['docs']);
      expect(onlyDocs).toEqual(['docs/guide.md']);

      const onlyInsights = discoverMarkdownFiles(walked, ['insights']);
      expect(onlyInsights).toEqual(['insights/note.md']);
    });

    it('returns [] for a repo with zero matching docs (a root that matches nothing)', async () => {
      const walked = await git.walkFiles(repo);
      const empty = discoverMarkdownFiles(walked, ['nonexistent-root']);
      expect(empty).toEqual([]);
    });

    it('is a pure function over its file-list input — no filesystem access', () => {
      const found = discoverMarkdownFiles(
        ['specs/a.md', 'docs/b.md', 'src/c.ts', 'specs/nested/d.md'],
        ['specs', 'docs'],
      );
      expect(found).toEqual(['docs/b.md', 'specs/a.md', 'specs/nested/d.md']);
    });
  });

  describe('isPathInDiscoverySet', () => {
    it('accepts a path present in the discovered set', () => {
      expect(isPathInDiscoverySet('specs/top.md', ['specs/top.md', 'docs/guide.md'])).toBe(true);
    });

    it('rejects a traversal/absolute/escaping-shaped path regardless of syntax', () => {
      const discovered = ['specs/top.md'];
      expect(isPathInDiscoverySet('../../.devdigest/secrets.json', discovered)).toBe(false);
      expect(isPathInDiscoverySet('/etc/passwd', discovered)).toBe(false);
      expect(isPathInDiscoverySet('specs/../../../etc/passwd', discovered)).toBe(false);
    });

    it('rejects a path merely absent from the set, even if plausible-looking', () => {
      expect(isPathInDiscoverySet('specs/nonexistent.md', ['specs/top.md'])).toBe(false);
    });

    it('accepts either a Set or an array as the discovered collection', () => {
      const set = new Set(['specs/top.md']);
      expect(isPathInDiscoverySet('specs/top.md', set)).toBe(true);
      expect(isPathInDiscoverySet('docs/guide.md', set)).toBe(false);
    });
  });
});
