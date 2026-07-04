/**
 * Pure helpers for the Intent Layer extractor pipeline.
 * See docs/superpowers/specs/2026-07-04-intent-layer-design.md §6.2, §8.3.
 */
import { createHash } from 'node:crypto';
import type { PrFile } from '@devdigest/shared';

/**
 * Freshness-key body hash: sha256 hex of `body ?? ''`. `null`/`undefined`/`''`
 * all hash identically so a never-had-a-body PR and an emptied-body PR share
 * the same freshness key (spec §6.2).
 */
export function bodyHashOf(body: string | null | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

/**
 * Assemble a clipped, per-file-budgeted diff summary for the LLM prompt.
 * Each file gets a proportional share of `totalCharBudget` based on its churn
 * (additions + deletions), clamped to [400, 4000] chars. Only the first 40
 * files are included; an overflow note is appended when there are more.
 * See spec §8.3 for the exact algorithm (mirrored here verbatim).
 */
export function clipDiff(files: PrFile[], totalCharBudget = 80_000): string {
  if (files.length === 0) return '(no files)';

  const totalChurn = files.reduce((s, f) => s + f.additions + f.deletions, 0) || 1;
  const chunks = files.slice(0, 40).map((f) => {
    const share = Math.floor((totalCharBudget * (f.additions + f.deletions)) / totalChurn);
    const perFile = Math.max(400, Math.min(share, 4_000));
    const patch = (f.patch ?? '').slice(0, perFile);
    return `--- ${f.path} (+${f.additions}/-${f.deletions}) ---\n${patch}`;
  });

  const overflow = files.length > 40 ? `\n(+${files.length - 40} more files)` : '';
  return chunks.join('\n\n') + overflow;
}
