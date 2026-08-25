import type { EvalExpectationKind } from "@devdigest/shared";

/** Severity → CSS colour token, mirroring FindingCard's mapping
 *  (`app/repos/[repoId]/pulls/[number]/_components/FindingCard/constants.ts`).
 *  Duplicated locally rather than imported — FindingCard's directory is a
 *  declared non-goal for this task, and this is a two-line constant. */
export const SEV_COLOR: Record<string, string> = {
  CRITICAL: "var(--crit)",
  WARNING: "var(--warn)",
  SUGGESTION: "var(--sugg)",
};

export const SEV_COLOR_FALLBACK = "var(--text-muted)";

/** Expectation kind → the `eval.expectation.*` message key. */
export const KIND_LABEL_KEY: Record<EvalExpectationKind, string> = {
  must_find: "mustFind",
  must_not_flag: "mustNotFlag",
};

export const EVAL_CASE_MODAL_WIDTH = 720;
