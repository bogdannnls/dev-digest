import { describe, it, expect } from 'vitest';
import { composeSmartDiff, type ComposerFile, type ComposerFinding } from './smart-diff.js';

/** Shorthand for a changed file. */
function file(path: string, additions = 0, deletions = 0): ComposerFile {
  return { path, additions, deletions };
}

/** Shorthand for a finding. */
function finding(file: string, start_line: number): ComposerFinding {
  return { file, start_line };
}

describe('composeSmartDiff — empty inputs', () => {
  it('returns three empty groups and a zeroed split_suggestion', () => {
    const result = composeSmartDiff([], []);

    expect(result.groups).toEqual([
      { role: 'core', files: [] },
      { role: 'wiring', files: [] },
      { role: 'boilerplate', files: [] },
    ]);
    expect(result.split_suggestion).toEqual({
      too_big: false,
      total_lines: 0,
      proposed_splits: [],
    });
  });
});

describe('composeSmartDiff — basic grouping', () => {
  it('places files into their classified group', () => {
    const files = [file('src/foo.ts'), file('src/index.ts'), file('pnpm-lock.yaml')];
    const result = composeSmartDiff(files, []);

    const byRole = new Map(result.groups.map((g) => [g.role, g.files.map((f) => f.path)]));
    expect(byRole.get('core')).toEqual(['src/foo.ts']);
    expect(byRole.get('wiring')).toEqual(['src/index.ts']);
    expect(byRole.get('boilerplate')).toEqual(['pnpm-lock.yaml']);
  });
});

describe('composeSmartDiff — group order', () => {
  it('always presents groups in [core, wiring, boilerplate] order', () => {
    const result = composeSmartDiff([], []);
    expect(result.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
  });
});

describe('composeSmartDiff — finding_lines mapping', () => {
  it('maps findings on the same file to sorted finding_lines', () => {
    const files = [file('src/foo.ts')];
    const findings = [finding('src/foo.ts', 40), finding('src/foo.ts', 10)];
    const result = composeSmartDiff(files, findings);

    const core = result.groups.find((g) => g.role === 'core')!;
    expect(core.files[0]!.finding_lines).toEqual([10, 40]);
  });

  it('preserves duplicate finding lines (no dedup)', () => {
    const files = [file('src/foo.ts')];
    const findings = [finding('src/foo.ts', 7), finding('src/foo.ts', 7)];
    const result = composeSmartDiff(files, findings);

    const core = result.groups.find((g) => g.role === 'core')!;
    expect(core.files[0]!.finding_lines).toEqual([7, 7]);
    expect(core.files[0]!.finding_lines).toHaveLength(2);
  });

  it('sorts out-of-order findings ascending', () => {
    const files = [file('src/foo.ts')];
    const findings = [finding('src/foo.ts', 99), finding('src/foo.ts', 1), finding('src/foo.ts', 50)];
    const result = composeSmartDiff(files, findings);

    const core = result.groups.find((g) => g.role === 'core')!;
    expect(core.files[0]!.finding_lines).toEqual([1, 50, 99]);
  });

  it('ignores findings anchored to files absent from the input file list', () => {
    const files = [file('src/foo.ts')];
    const findings = [finding('nonexistent.ts', 5)];
    const result = composeSmartDiff(files, findings);

    for (const group of result.groups) {
      for (const f of group.files) {
        expect(f.path).not.toBe('nonexistent.ts');
      }
    }
    const core = result.groups.find((g) => g.role === 'core')!;
    expect(core.files[0]!.finding_lines).toEqual([]);
  });
});

describe('composeSmartDiff — total_lines', () => {
  it('sums additions + deletions across all files', () => {
    const files = [file('a.ts', 5, 10), file('b.ts', 20, 30), file('c.ts', 0, 50)];
    const result = composeSmartDiff(files, []);
    expect(result.split_suggestion.total_lines).toBe(115);
  });
});

describe('composeSmartDiff — too_big boundary', () => {
  it('is false at exactly the threshold (1000 total lines)', () => {
    const files = [file('a.ts', 1000, 0)];
    const result = composeSmartDiff(files, []);
    expect(result.split_suggestion.total_lines).toBe(1000);
    expect(result.split_suggestion.too_big).toBe(false);
  });

  it('is true one line over the threshold (1001 total lines)', () => {
    const files = [file('a.ts', 1001, 0)];
    const result = composeSmartDiff(files, []);
    expect(result.split_suggestion.total_lines).toBe(1001);
    expect(result.split_suggestion.too_big).toBe(true);
  });
});

describe('composeSmartDiff — reserved LLM fields', () => {
  it('sets pseudocode_summary to null on every emitted file', () => {
    const files = [file('src/foo.ts'), file('src/index.ts'), file('pnpm-lock.yaml')];
    const result = composeSmartDiff(files, []);

    for (const group of result.groups) {
      for (const f of group.files) {
        expect(f.pseudocode_summary).toBeNull();
      }
    }
  });

  it('always returns an empty proposed_splits array', () => {
    const files = [file('a.ts', 2000, 0)];
    const result = composeSmartDiff(files, []);
    expect(result.split_suggestion.proposed_splits).toEqual([]);
  });
});

describe('composeSmartDiff — input order preservation', () => {
  it('preserves the input file order within a group', () => {
    const files = [file('b.ts'), file('a.ts')];
    const result = composeSmartDiff(files, []);

    const core = result.groups.find((g) => g.role === 'core')!;
    expect(core.files.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
  });
});
