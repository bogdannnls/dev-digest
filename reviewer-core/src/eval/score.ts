import type { Finding } from '@devdigest/shared';

/**
 * Deterministic eval scorer — zero LLM calls, zero I/O.
 *
 * Scores a set of eval cases (each a synthetic diff run through
 * `reviewPullRequest` elsewhere) against their expected outcome. This module
 * is a pure function of its arguments: no `fs`, no `fetch`, no
 * `process.env`, no import from `reviewer-core/src/llm/**`. That boundary is
 * the structural proof that "scoring makes no LLM call" — see
 * `docs/features/2026-08-25-eval-pipeline/contract.md` section 3.
 *
 * `EvalExpectationLike` is declared structurally here rather than imported
 * from `@devdigest/shared`: the Zod contract (`EvalExpectation` in
 * `contracts/eval-ci.ts`) is authored separately and reviewer-core must not
 * depend on it. Only `kind`, `file`, `start_line`, `end_line` participate in
 * scoring — `severity`/`category`/`title` (present on the wire contract for
 * display) are display-only and deliberately absent here.
 */
export type EvalExpectationKind = 'must_find' | 'must_not_flag';

export interface EvalExpectationLike {
  kind: EvalExpectationKind;
  file: string;
  start_line: number;
  end_line: number;
}

export interface CaseScore {
  pass: boolean;
  /** id of the first finding satisfying `matches`, or null if none did. */
  matchedFindingId: string | null;
  /** <= 1 per case — the case's true positive, if any (must_find only). */
  truePositives: number;
  falsePositives: number;
}

/** One case's inputs to batch scoring: its expectation, its post-grounding
 * findings, and its kept/dropped counts from the grounding gate. */
export interface EvalCaseScoreInput {
  expectation: EvalExpectationLike;
  /** `outcome.review.findings` — post-grounding, in returned order. */
  findings: Finding[];
  /** `outcome.review.findings.length` for this case. */
  kept: number;
  /** `outcome.dropped.length` for this case. */
  dropped: number;
}

export interface BatchScore {
  recall: number | null;
  precision: number | null;
  citation_accuracy: number | null;
  traces_passed: number;
  traces_total: number;
}

/** Strip a single leading `./` and trim whitespace. No basename fallback,
 * no case folding, no fuzzy path matching. */
function normalize(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
}

/**
 * The match predicate (contract 3.1): same normalized file, and the
 * finding's [start_line, end_line] range intersects the expectation's,
 * inclusive on both ends.
 */
export function matches(finding: Finding, expectation: EvalExpectationLike): boolean {
  if (normalize(finding.file) !== normalize(expectation.file)) return false;
  return !(finding.end_line < expectation.start_line || finding.start_line > expectation.end_line);
}

/**
 * Score a single case (contract 3.2).
 *
 * `must_find` — the first finding (in returned order) satisfying `matches`
 * is the true positive and `pass = true`; every other finding produced for
 * the case is a false positive. No match -> `pass = false`, every finding
 * is a false positive.
 *
 * `must_not_flag` — `pass = true` iff no finding matches. A `must_not_flag`
 * case never produces a true positive, so every finding it produces is a
 * false positive.
 */
export function scoreCase(expectation: EvalExpectationLike, findings: Finding[]): CaseScore {
  let matchedFindingId: string | null = null;
  for (const finding of findings) {
    if (matches(finding, expectation)) {
      matchedFindingId = finding.id;
      break;
    }
  }

  if (expectation.kind === 'must_find') {
    const pass = matchedFindingId !== null;
    const truePositives = pass ? 1 : 0;
    return { pass, matchedFindingId, truePositives, falsePositives: findings.length - truePositives };
  }

  // must_not_flag: never a true positive; every finding is a false positive.
  return {
    pass: matchedFindingId === null,
    matchedFindingId,
    truePositives: 0,
    falsePositives: findings.length,
  };
}

/**
 * Score a batch of cases (contract 3.3 / 3.4).
 *
 * Every metric is `null` when its denominator is zero — never `0`, never
 * `1`: `recall` needs at least one `must_find` case, `precision` needs at
 * least one produced finding, `citation_accuracy` needs at least one
 * kept-or-dropped finding across the batch.
 */
export function scoreBatch(cases: EvalCaseScoreInput[]): BatchScore {
  let truePositives = 0;
  let totalFindings = 0;
  let mustFindCases = 0;
  let kept = 0;
  let dropped = 0;
  let tracesPassed = 0;

  for (const c of cases) {
    const { pass, truePositives: tp, falsePositives: fp } = scoreCase(c.expectation, c.findings);
    truePositives += tp;
    totalFindings += tp + fp;
    if (c.expectation.kind === 'must_find') mustFindCases += 1;
    kept += c.kept;
    dropped += c.dropped;
    if (pass) tracesPassed += 1;
  }

  return {
    recall: mustFindCases === 0 ? null : truePositives / mustFindCases,
    precision: totalFindings === 0 ? null : truePositives / totalFindings,
    citation_accuracy: kept + dropped === 0 ? null : kept / (kept + dropped),
    traces_passed: tracesPassed,
    traces_total: cases.length,
  };
}
