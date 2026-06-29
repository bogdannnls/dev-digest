import { describe, it, expect } from 'vitest';
import { listFixtures, loadFixture } from '../src/modules/agents/eval-fixtures.js';

describe('eval-fixtures', () => {
  it('lists both shipped fixtures by id', () => {
    const ids = listFixtures().map((f) => f.id);
    expect(ids).toEqual(['api-contract-change', 'test-only-happy-path']); // sorted
  });

  it('loadFixture returns meta + a parsed UnifiedDiff for a known id', () => {
    const fx = loadFixture('test-only-happy-path');
    expect(fx).toBeDefined();
    expect(fx!.meta.title).toMatch(/discount/i);
    expect(fx!.unifiedDiff.files.length).toBeGreaterThan(0);
    expect(fx!.unifiedDiff.files[0]!.hunks.length).toBeGreaterThan(0);
  });

  it('loadFixture returns undefined for an unknown id', () => {
    expect(loadFixture('does-not-exist')).toBeUndefined();
  });
});
