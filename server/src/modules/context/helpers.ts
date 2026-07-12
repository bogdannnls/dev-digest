/**
 * Pure discovery helpers for the Project Context reader (L05 T1).
 *
 * Onion MUST.2: every filesystem access — including the recursive directory
 * walk — lives behind the `GitClient` adapter (`GitClient.walkFiles`, see
 * `adapters/git/simple-git.ts`). This module never touches `node:fs`; it only
 * filters an already-walked, clone-relative file list.
 */

/**
 * Discover every `.md` path (from `files`, clone-relative & posix-style —
 * `/`-separated even on Windows — exactly as produced by `GitClient.walkFiles`)
 * whose relative path passes through one of `roots` as an EXACT directory-name
 * segment, at any depth — implementing `**\/{specs,docs,insights}/**\/*.md`
 * (AC-1) without a glob dependency. `roots` is server-side config
 * (`config.contextRoots`, AC-8), never hardcoded per call site.
 *
 * Returns clone-relative, posix-style paths, sorted for deterministic output.
 */
export function discoverMarkdownFiles(
  files: readonly string[],
  roots: readonly string[],
): string[] {
  const rootSet = new Set(roots);
  const out: string[] = [];
  for (const rel of files) {
    if (!rel.endsWith('.md')) continue;
    const segments = rel.split('/');
    const dirSegments = segments.slice(0, -1);
    if (dirSegments.some((seg) => rootSet.has(seg))) {
      out.push(rel);
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
