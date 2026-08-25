/**
 * Verification gate for the Eval Pipeline scorer (contract section 3,
 * `docs/features/2026-08-25-eval-pipeline/contract.md`).
 *
 * Pure unit test — no DB, no testcontainers, no LLM, no network, no fs. It
 * imports the scorer straight from `@devdigest/reviewer-core`; hermeticity
 * here is the evidence that "scoring makes zero LLM calls" (contract §3,
 * §6) is structurally true and not merely asserted.
 */

import { describe, it, expect } from 'vitest';
import { matches, scoreCase, scoreBatch, type EvalExpectationLike, type EvalCaseScoreInput } from '@devdigest/reviewer-core';
import type { Finding } from '@devdigest/shared';

let nextId = 0;

/** Shorthand for a Finding fixture — only file/start_line/end_line matter to
 * the scorer; everything else is filler to satisfy the wire shape. */
function makeFinding(file: string, start_line: number, end_line: number): Finding {
  nextId += 1;
  return {
    id: `f${nextId}`,
    severity: 'WARNING',
    category: 'bug',
    title: 'fixture finding',
    file,
    start_line,
    end_line,
    rationale: 'fixture',
    confidence: 0.9,
  };
}

/** Shorthand for an EvalExpectation (scoring-relevant fields only, per contract §2.1). */
function expectation(
  kind: EvalExpectationLike['kind'],
  file: string,
  start_line: number,
  end_line: number,
): EvalExpectationLike {
  return { kind, file, start_line, end_line };
}

describe('matches — file + range predicate (contract §3.1)', () => {
  it('matches when the finding range overlaps the expectation range in the same file', () => {
    const finding = makeFinding('src/foo.ts', 10, 20);
    const exp = expectation('must_find', 'src/foo.ts', 15, 18);
    expect(matches(finding, exp)).toBe(true);
  });

  it('matches at the inclusive lower boundary — finding end_line equals expectation start_line', () => {
    const finding = makeFinding('src/foo.ts', 1, 10);
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    expect(matches(finding, exp)).toBe(true);
  });

  it('matches at the inclusive upper boundary — finding start_line equals expectation end_line', () => {
    const finding = makeFinding('src/foo.ts', 20, 30);
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    expect(matches(finding, exp)).toBe(true);
  });

  it('does not match when the finding range falls one line short below the expectation', () => {
    const finding = makeFinding('src/foo.ts', 1, 9);
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    expect(matches(finding, exp)).toBe(false);
  });

  it('does not match when the finding range falls one line short above the expectation', () => {
    const finding = makeFinding('src/foo.ts', 21, 30);
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    expect(matches(finding, exp)).toBe(false);
  });

  it('never matches a different file, however well the lines line up', () => {
    const finding = makeFinding('src/other.ts', 10, 20);
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    expect(matches(finding, exp)).toBe(false);
  });

  it('normalizes a leading "./" so "./x.ts" and "x.ts" refer to the same path', () => {
    const finding = makeFinding('./x.ts', 5, 5);
    const exp = expectation('must_find', 'x.ts', 5, 5);
    expect(matches(finding, exp)).toBe(true);
  });
});

describe('scoreCase — must_find (contract §3.2)', () => {
  it('a hit sets pass=true and credits exactly one true positive', () => {
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    const finding = makeFinding('src/foo.ts', 12, 12);
    const result = scoreCase(exp, [finding]);

    expect(result.pass).toBe(true);
    expect(result.matchedFindingId).toBe(finding.id);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(0);
  });

  it('a miss sets pass=false, zero true positives, and every finding is a false positive', () => {
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    const finding = makeFinding('src/foo.ts', 40, 45);
    const result = scoreCase(exp, [finding]);

    expect(result.pass).toBe(false);
    expect(result.matchedFindingId).toBeNull();
    expect(result.truePositives).toBe(0);
    expect(result.falsePositives).toBe(1);
  });

  it('when several findings match, only the first is credited — the rest are false positives', () => {
    const exp = expectation('must_find', 'src/foo.ts', 10, 20);
    const first = makeFinding('src/foo.ts', 11, 11);
    const second = makeFinding('src/foo.ts', 15, 15);
    const result = scoreCase(exp, [first, second]);

    expect(result.pass).toBe(true);
    expect(result.matchedFindingId).toBe(first.id);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(1);
  });
});

describe('scoreCase — must_not_flag (contract §3.2)', () => {
  it('no matching finding passes', () => {
    const exp = expectation('must_not_flag', 'src/foo.ts', 10, 20);
    const finding = makeFinding('src/foo.ts', 40, 45);
    const result = scoreCase(exp, [finding]);

    expect(result.pass).toBe(true);
    expect(result.matchedFindingId).toBeNull();
    expect(result.truePositives).toBe(0);
    expect(result.falsePositives).toBe(1);
  });

  it('a matching finding fails the case', () => {
    const exp = expectation('must_not_flag', 'src/foo.ts', 10, 20);
    const finding = makeFinding('src/foo.ts', 12, 12);
    const result = scoreCase(exp, [finding]);

    expect(result.pass).toBe(false);
    expect(result.matchedFindingId).toBe(finding.id);
    expect(result.truePositives).toBe(0);
  });

  it('never produces a true positive — every finding it produces is a false positive', () => {
    const exp = expectation('must_not_flag', 'src/foo.ts', 10, 20);
    const matching = makeFinding('src/foo.ts', 12, 12);
    const unrelated = makeFinding('src/bar.ts', 1, 1);
    const result = scoreCase(exp, [matching, unrelated]);

    expect(result.truePositives).toBe(0);
    expect(result.falsePositives).toBe(2);
  });
});

describe('scoreBatch — recall / precision over a mixed batch (contract §3.3)', () => {
  it('computes recall and precision against hand-computed expected values', () => {
    // Case A: must_find, hit, no noise.
    const caseA: EvalCaseScoreInput = {
      expectation: expectation('must_find', 'a.ts', 1, 5),
      findings: [makeFinding('a.ts', 2, 2)],
      kept: 1,
      dropped: 0,
    };
    // Case B: must_find, miss.
    const caseB: EvalCaseScoreInput = {
      expectation: expectation('must_find', 'b.ts', 1, 5),
      findings: [makeFinding('b.ts', 40, 40)],
      kept: 1,
      dropped: 0,
    };
    // Case C: must_not_flag, correctly silent.
    const caseC: EvalCaseScoreInput = {
      expectation: expectation('must_not_flag', 'c.ts', 1, 5),
      findings: [],
      kept: 0,
      dropped: 0,
    };

    // TP = 1 (case A), F = 1 (a.ts) + 1 (b.ts) + 0 (c.ts) = 2, MF = 2 (A, B).
    const result = scoreBatch([caseA, caseB, caseC]);

    expect(result.recall).toBe(0.5); // 1 TP / 2 must_find cases
    expect(result.precision).toBe(0.5); // 1 TP / 2 total findings
  });

  it('strict precision: a must_find hit that also emits unrelated noise keeps pass true but drags precision down', () => {
    const hit = makeFinding('a.ts', 2, 2);
    const noise1 = makeFinding('a.ts', 50, 50);
    const noise2 = makeFinding('a.ts', 60, 60);
    const exp = expectation('must_find', 'a.ts', 1, 5);

    const caseScore = scoreCase(exp, [hit, noise1, noise2]);
    expect(caseScore.pass).toBe(true); // pass: the expected thing was found

    const batch = scoreBatch([
      { expectation: exp, findings: [hit, noise1, noise2], kept: 3, dropped: 0 },
    ]);

    // pass is true, but precision is a separate lens: 1 TP / 3 total findings.
    expect(batch.traces_passed).toBe(1);
    expect(batch.precision).toBe(1 / 3);
  });
});

describe('scoreBatch — citation_accuracy from kept/dropped (contract §3.3)', () => {
  it('computes citation_accuracy from summed kept/dropped counts, including a case with drops', () => {
    const cases: EvalCaseScoreInput[] = [
      {
        expectation: expectation('must_find', 'a.ts', 1, 5),
        findings: [makeFinding('a.ts', 2, 2)],
        kept: 1,
        dropped: 0,
      },
      {
        expectation: expectation('must_find', 'b.ts', 1, 5),
        findings: [makeFinding('b.ts', 2, 2)],
        kept: 1,
        dropped: 2, // grounding gate dropped 2 findings for this case
      },
    ];

    // kept = 2, dropped = 2 -> citation_accuracy = 2 / 4 = 0.5
    const result = scoreBatch(cases);
    expect(result.citation_accuracy).toBe(0.5);
  });
});

describe('scoreBatch — vacuous denominators are null, never 0 (contract §3.4)', () => {
  it('recall is null when the batch has no must_find cases', () => {
    const cases: EvalCaseScoreInput[] = [
      {
        expectation: expectation('must_not_flag', 'a.ts', 1, 5),
        findings: [],
        kept: 0,
        dropped: 0,
      },
    ];
    const result = scoreBatch(cases);
    expect(result.recall).toBeNull();
  });

  it('precision is null when the batch produced zero findings', () => {
    const cases: EvalCaseScoreInput[] = [
      {
        expectation: expectation('must_find', 'a.ts', 1, 5),
        findings: [],
        kept: 0,
        dropped: 0,
      },
      {
        expectation: expectation('must_not_flag', 'b.ts', 1, 5),
        findings: [],
        kept: 0,
        dropped: 0,
      },
    ];
    const result = scoreBatch(cases);
    expect(result.precision).toBeNull();
  });

  it('citation_accuracy is null when kept + dropped is zero across the batch', () => {
    const cases: EvalCaseScoreInput[] = [
      {
        expectation: expectation('must_find', 'a.ts', 1, 5),
        findings: [],
        kept: 0,
        dropped: 0,
      },
    ];
    const result = scoreBatch(cases);
    expect(result.citation_accuracy).toBeNull();
  });
});

describe('scoreBatch — traces_passed / traces_total over a mixed batch (contract §3.3)', () => {
  it('counts passed cases and total cases independently of recall/precision', () => {
    const cases: EvalCaseScoreInput[] = [
      // pass: must_find hit
      {
        expectation: expectation('must_find', 'a.ts', 1, 5),
        findings: [makeFinding('a.ts', 2, 2)],
        kept: 1,
        dropped: 0,
      },
      // fail: must_find miss
      {
        expectation: expectation('must_find', 'b.ts', 1, 5),
        findings: [makeFinding('b.ts', 40, 40)],
        kept: 1,
        dropped: 0,
      },
      // pass: must_not_flag correctly silent
      {
        expectation: expectation('must_not_flag', 'c.ts', 1, 5),
        findings: [],
        kept: 0,
        dropped: 0,
      },
      // fail: must_not_flag incorrectly flagged
      {
        expectation: expectation('must_not_flag', 'd.ts', 1, 5),
        findings: [makeFinding('d.ts', 2, 2)],
        kept: 1,
        dropped: 0,
      },
    ];

    const result = scoreBatch(cases);
    expect(result.traces_passed).toBe(2);
    expect(result.traces_total).toBe(4);
  });
});
