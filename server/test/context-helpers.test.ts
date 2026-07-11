/**
 * Unit tests (no Docker) for the pure Project Context discovery helpers.
 * Uses real temp directories (fs.mkdtemp) — these functions are plain
 * `node:fs` walks, not adapters, so no mock/container wiring is needed here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { walk, discoverMarkdownFiles, isPathInDiscoverySet } from '../src/modules/context/helpers.js';

describe('modules/context/helpers', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctx-helpers-'));
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

  describe('walk', () => {
    it('collects files recursively and never descends into ignored dirs', async () => {
      const files = await walk(root);
      expect(files.some((f) => f.split(sep).includes('node_modules'))).toBe(false);
      expect(files.some((f) => f.split(sep).includes('.git'))).toBe(false);
      expect(files.some((f) => f.endsWith(join('src', 'index.ts')))).toBe(true);
    });

    it('never follows a symlink — file or directory, escaping or not', async () => {
      const files = await walk(root);
      expect(files.some((f) => f.endsWith('escape.md'))).toBe(false);
      expect(files.some((f) => f.includes('escaped-dir'))).toBe(false);
      expect(files.some((f) => f.endsWith('secret.md'))).toBe(false);
    });
  });

  describe('discoverMarkdownFiles', () => {
    it('finds nested .md files under specs/docs/insights at any depth (AC-1)', async () => {
      const found = await discoverMarkdownFiles(root, ['specs', 'docs', 'insights']);
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
      const found = await discoverMarkdownFiles(root, ['specs', 'docs', 'insights']);
      expect(found).not.toContain('README.md');
    });

    it('excludes a symlink escaping the clone dir, even placed under a matching root (AC-7)', async () => {
      const found = await discoverMarkdownFiles(root, ['specs', 'docs', 'insights']);
      expect(found).not.toContain('specs/escape.md');
      expect(found.some((f) => f.includes('escaped-dir'))).toBe(false);
      expect(found.some((f) => f.includes('secret'))).toBe(false);
    });

    it('never descends into node_modules/.git even when they contain a same-named root dir', async () => {
      const found = await discoverMarkdownFiles(root, ['specs', 'docs', 'insights']);
      expect(found.some((f) => f.includes('node_modules'))).toBe(false);
      expect(found.some((f) => f.includes('.git'))).toBe(false);
    });

    it('changing configured roots changes the discovered set (AC-8)', async () => {
      const onlyDocs = await discoverMarkdownFiles(root, ['docs']);
      expect(onlyDocs).toEqual(['docs/guide.md']);

      const onlyInsights = await discoverMarkdownFiles(root, ['insights']);
      expect(onlyInsights).toEqual(['insights/note.md']);
    });

    it('returns [] for a repo with zero matching docs (a root that matches nothing)', async () => {
      const empty = await discoverMarkdownFiles(root, ['nonexistent-root']);
      expect(empty).toEqual([]);
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
