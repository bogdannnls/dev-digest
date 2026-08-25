/**
 * Assembles unified-diff text from `{ path, patch }` records. Pure string
 * assembly only — no repository access, no I/O, no `parseUnifiedDiff` call.
 * Callers own fetching the records and parsing the returned text themselves.
 *
 * Serves two callers with one implementation (onion MUST.4 forbids
 * `modules/eval` importing `modules/reviews`, so this lives in `_shared`):
 *  - whole-PR reconstruction (`modules/reviews/diff-loader.ts`,
 *    `diffFromPrFiles`) — many files, joined by newline.
 *  - single-file fragment for one finding (`modules/eval`, contract §4.4
 *    step 4) — an array of one.
 *
 * Records with a null/empty `patch` are skipped, matching the pre-existing
 * `diffFromPrFiles` behavior.
 */
export interface DiffFragmentSource {
  path: string;
  patch: string | null;
}

export function assembleDiffFragment(files: DiffFragmentSource[]): string {
  const parts: string[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    parts.push(`diff --git a/${f.path} b/${f.path}`);
    parts.push(`--- a/${f.path}`);
    parts.push(`+++ b/${f.path}`);
    parts.push(f.patch);
  }
  return parts.join('\n');
}
