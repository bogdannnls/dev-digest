import { describe, it, expect } from 'vitest';
import { bodyHashOf, clipDiff } from './helpers.js';
import type { PrFile } from '@devdigest/shared';

describe('bodyHashOf', () => {
  it('hashes null, undefined, and empty string identically', () => {
    const empty = bodyHashOf('');
    expect(bodyHashOf(null)).toBe(empty);
    expect(bodyHashOf(undefined)).toBe(empty);
  });

  it('hashes different bodies differently', () => {
    expect(bodyHashOf('hello')).not.toBe(bodyHashOf('world'));
  });

  it('is deterministic for the same input', () => {
    expect(bodyHashOf('same body')).toBe(bodyHashOf('same body'));
  });
});

describe('clipDiff', () => {
  it('returns a placeholder for an empty file list', () => {
    expect(clipDiff([])).toBe('(no files)');
  });

  it('gives each file a proportional share of the budget, clamped to [400, 4000]', () => {
    const files: PrFile[] = [
      { path: 'big.ts', additions: 900, deletions: 0, patch: 'x'.repeat(10_000) },
      { path: 'small.ts', additions: 10, deletions: 0, patch: 'y'.repeat(10_000) },
    ];
    const result = clipDiff(files, 1_000);

    // big.ts: share = floor(1000 * 900/910) ≈ 989 → clamped to 989 (within [400,4000])
    const bigChunk = result.split('\n\n')[0]!;
    const bigPatchLen = bigChunk.split('---\n')[1]!.length;
    expect(bigPatchLen).toBeGreaterThanOrEqual(400);
    expect(bigPatchLen).toBeLessThanOrEqual(4_000);

    // small.ts: share = floor(1000 * 10/910) ≈ 10 → clamped up to the 400 floor
    const smallChunk = result.split('\n\n')[1]!;
    const smallPatchLen = smallChunk.split('---\n')[1]!.length;
    expect(smallPatchLen).toBe(400);
  });

  it('clamps a huge proportional share down to the 4000 ceiling', () => {
    const files: PrFile[] = [{ path: 'only.ts', additions: 100, deletions: 0, patch: 'z'.repeat(10_000) }];
    const result = clipDiff(files, 80_000);
    const patchLen = result.split('---\n')[1]!.length;
    expect(patchLen).toBe(4_000);
  });

  it('includes at most 40 files and appends an overflow note beyond that', () => {
    const files: PrFile[] = Array.from({ length: 45 }, (_, i) => ({
      path: `file-${i}.ts`,
      additions: 1,
      deletions: 0,
      patch: 'x',
    }));
    const result = clipDiff(files);
    expect(result).toContain('(+5 more files)');
    expect(result).not.toContain('file-44.ts');
    expect(result).toContain('file-39.ts');
  });

  it('handles files with no patch (null) without throwing', () => {
    const files: PrFile[] = [{ path: 'binary.png', additions: 0, deletions: 0, patch: null }];
    expect(() => clipDiff(files)).not.toThrow();
    expect(clipDiff(files)).toContain('binary.png');
  });
});
