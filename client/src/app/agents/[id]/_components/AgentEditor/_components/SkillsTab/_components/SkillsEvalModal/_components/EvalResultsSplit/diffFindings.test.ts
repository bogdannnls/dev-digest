import { describe, it, expect } from 'vitest';
import { diffFindings } from './diffFindings.js';
import type { Finding } from '@devdigest/shared';

// Fixture helper — uses actual Finding schema field names: start_line, title.
// severity must be one of the Severity enum values: 'CRITICAL' | 'WARNING' | 'SUGGESTION'.
const f = (file: string, start_line: number, title: string): Finding => ({
  id: `${file}:${start_line}`,
  severity: 'WARNING',
  category: 'bug',
  title,
  file,
  start_line,
  end_line: start_line,
  rationale: '',
  confidence: 0.9,
});

describe('diffFindings', () => {
  it('marks unique-to-with findings as new', () => {
    const w = [f('a.ts', 1, 'X'), f('b.ts', 2, 'Y')];
    const wo = [f('a.ts', 1, 'X')];
    const out = diffFindings(w, wo);
    expect(out.withAnnotated.map((x) => x.annotation)).toEqual(['shared', 'new']);
    expect(out.withoutAnnotated.map((x) => x.annotation)).toEqual(['shared']);
  });

  it('marks unique-to-without findings as missing', () => {
    const w: Finding[] = [];
    const wo = [f('a.ts', 1, 'Z')];
    const out = diffFindings(w, wo);
    expect(out.withoutAnnotated[0]!.annotation).toBe('missing');
  });

  it('matches titles via normalised substring', () => {
    const w = [f('a.ts', 1, 'Missing branch: negative discount.')];
    const wo = [f('a.ts', 1, 'missing branch negative discount')];
    const out = diffFindings(w, wo);
    expect(out.withAnnotated[0]!.annotation).toBe('shared');
    expect(out.withoutAnnotated[0]!.annotation).toBe('shared');
  });

  it('different file or different start_line does not match even if title matches', () => {
    const w = [f('a.ts', 1, 'X')];
    const wo = [f('a.ts', 2, 'X')];
    const out = diffFindings(w, wo);
    expect(out.withAnnotated[0]!.annotation).toBe('new');
    expect(out.withoutAnnotated[0]!.annotation).toBe('missing');
  });
});
