/**
 * Pure discovery helpers for the Project Context reader (L05 T1).
 *
 * `walk` mirrors the hand-rolled recursion in
 * `adapters/codeindex/ripgrep.ts` (~line 128): `readdir(dir, { withFileTypes:
 * true })`, skip an ignore set, recurse into directories, collect files. No
 * new glob dependency is introduced (per the approved design).
 *
 * Symlink safety (AC-7): `Dirent.isDirectory()` / `Dirent.isFile()` reflect
 * the directory ENTRY's own type as reported by the `readdir` syscall — they
 * do NOT stat a symlink's target. A symlink entry therefore answers `false`
 * to both (verified empirically: `isSymbolicLink()` is `true`, the other two
 * are `false`), so this walk NEVER descends into, and NEVER collects, a
 * symlink — whether it points at a file or a directory, inside or outside the
 * walked tree. That is a strict superset of "don't follow a symlink that
 * escapes the clone root": no symlink is ever followed, full stop.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Directories never descended into — build artifacts, VCS metadata, deps. */
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

/**
 * Recursively collect absolute file paths under `dir`. Never follows a
 * symlink (see module header). Missing/unreadable directories yield `[]`
 * rather than throwing — callers decide what "nothing here" means.
 */
export async function walk(dir: string): Promise<string[]> {
  const acc: string[] = [];
  await walkInto(dir, acc);
  return acc;
}

async function walkInto(dir: string, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkInto(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
    // A symlink entry is neither isDirectory() nor isFile() here — it is
    // silently skipped: never traversed, never collected.
  }
}

/**
 * Discover every `.md` file under `cloneRoot` whose relative path passes
 * through one of `roots` as an EXACT directory-name segment, at any depth —
 * implementing `**\/{specs,docs,insights}/**\/*.md` (AC-1) without a glob
 * dependency. `roots` is server-side config (`config.contextRoots`, AC-8),
 * never hardcoded per call site.
 *
 * Returns clone-relative, posix-style paths (`/`-separated even on Windows),
 * sorted for deterministic output.
 */
export async function discoverMarkdownFiles(
  cloneRoot: string,
  roots: readonly string[],
): Promise<string[]> {
  const rootSet = new Set(roots);
  const absolute = await walk(cloneRoot);
  const out: string[] = [];
  for (const abs of absolute) {
    if (!abs.endsWith('.md')) continue;
    const rel = relative(cloneRoot, abs);
    const segments = rel.split(sep);
    const dirSegments = segments.slice(0, -1);
    if (dirSegments.some((seg) => rootSet.has(seg))) {
      out.push(segments.join('/'));
    }
  }
  return out.sort();
}

/**
 * Whitelist membership check — the ONLY gate a path should ever pass through
 * before being read (AC-3, AC-34). `discovered` MUST be a set freshly
 * produced by `discoverMarkdownFiles` against the repo's CURRENT clone
 * state; a path is safe to read if and only if it is present, verbatim, in
 * that set.
 *
 * This subsumes traversal (`../`), absolute-path, and symlink-escape
 * rejection for free: none of those syntactic shapes can ever appear as an
 * entry `discoverMarkdownFiles` itself produced, so an attacker-supplied
 * string in any of those shapes simply never matches — no separate
 * normalize-then-compare step is needed or should be added here.
 */
export function isPathInDiscoverySet(
  path: string,
  discovered: readonly string[] | ReadonlySet<string>,
): boolean {
  const set = discovered instanceof Set ? discovered : new Set(discovered);
  return set.has(path);
}
