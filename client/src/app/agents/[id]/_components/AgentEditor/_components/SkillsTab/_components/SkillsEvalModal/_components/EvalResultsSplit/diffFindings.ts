import type { Finding } from '@devdigest/shared';

export type AnnotatedFinding = Finding & { annotation: 'new' | 'missing' | 'shared' };

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function similar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return na === nb;
  return na.includes(nb) || nb.includes(na);
}

function findMatch(needle: Finding, haystack: Finding[]): Finding | undefined {
  return haystack.find(
    (f) => f.file === needle.file && f.start_line === needle.start_line && similar(f.title, needle.title),
  );
}

export function diffFindings(
  withSkills: Finding[],
  withoutSkills: Finding[],
): { withAnnotated: AnnotatedFinding[]; withoutAnnotated: AnnotatedFinding[] } {
  const withAnnotated = withSkills.map<AnnotatedFinding>((f) => ({
    ...f,
    annotation: findMatch(f, withoutSkills) ? 'shared' : 'new',
  }));
  const withoutAnnotated = withoutSkills.map<AnnotatedFinding>((f) => ({
    ...f,
    annotation: findMatch(f, withSkills) ? 'shared' : 'missing',
  }));
  return { withAnnotated, withoutAnnotated };
}
