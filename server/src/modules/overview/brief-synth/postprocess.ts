/**
 * Pure, IO-free deterministic post-processing for the Why + Risk Brief
 * synthesis call (SPEC-02). No DB, no LLM — every function here operates
 * only on already-fetched data (the raw model output, the input finding
 * set, and the PR's cached intent risk areas).
 *
 * See specs/2026-07-13-why-risk-brief-spec.md AC-3, AC-4, AC-7, AC-9,
 * AC-14, AC-15 and docs/superpowers/plans/2026-07-13-why-risk-brief-plan.md (T12).
 */
import type { RiskArea, RiskAreaIcon, ReviewFocusItem, RiskSeverity } from '@devdigest/shared';
import { BLOCKER_SEVERITIES } from '../brief/aggregate.js';

/**
 * The subset of a `findings` row this module needs. Callers (the T3 input
 * assembler / T6 service) are expected to have already excluded dismissed
 * findings from the candidate set (AC-8); `dismissedAt` is still accepted
 * here (optional) so `buildRisks`' "non-dismissed" rule (AC-4) holds even
 * if a caller passes an unfiltered set.
 */
export type PostprocessFinding = {
  id: string;
  file: string;
  startLine: number;
  severity: string;
  category: string;
  dismissedAt?: string | Date | null;
};

/** The PR's cached `intent.riskAreas` entries — reused verbatim (AC-3). */
export type IntentRiskArea = {
  icon: RiskAreaIcon;
  label: string;
};

/** The model's raw structured output for this feature's one `completeStructured` call (T5). */
export type SynthesizedBriefRaw = {
  what: string;
  why: string;
  riskLevel: RiskSeverity;
  reviewFocus: ReviewFocusItem[];
};

/** The raw model output after all deterministic post-processing has been applied. */
export type PostprocessedBrief = {
  what: string;
  why: string;
  riskLevel: RiskSeverity;
  reviewFocus: ReviewFocusItem[];
  risks: RiskArea[];
};

export const REVIEW_FOCUS_CAP = 8;

/**
 * AC-7: drop any `reviewFocus[].findingId` not present in the finding set
 * given to the same call. Must run before capping (T12 step 1 — "before
 * anything else").
 */
export function dropUnknownFindingIds(
  reviewFocus: readonly ReviewFocusItem[],
  validFindingIds: ReadonlySet<string> | readonly string[],
): ReviewFocusItem[] {
  const valid = validFindingIds instanceof Set ? validFindingIds : new Set(validFindingIds);
  return reviewFocus.filter((item) => valid.has(item.findingId));
}

/**
 * AC-9: cap `reviewFocus[]` at `max` (8) entries, preserving the model's
 * own order — index 0 stays "read first". Overflow is dropped, not
 * reordered or resorted.
 */
export function capReviewFocus(
  reviewFocus: readonly ReviewFocusItem[],
  max: number = REVIEW_FOCUS_CAP,
): ReviewFocusItem[] {
  return reviewFocus.slice(0, max);
}

/** `riskLevel` ordering: low < medium < high. */
const RISK_LEVEL_RANK: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2 };

/**
 * AC-14/AC-15: floor `riskLevel` to at least `'high'` when any input
 * finding's severity is blocker-tier (case-insensitive `BLOCKER_SEVERITIES`
 * semantics). Never lowers a model value that is already `'high'` or above
 * the floor — this is a lower bound only.
 */
export function floorRiskLevel(
  modelRiskLevel: RiskSeverity,
  findings: readonly Pick<PostprocessFinding, 'severity'>[],
): RiskSeverity {
  const hasBlockerTierFinding = findings.some((f) => BLOCKER_SEVERITIES.has(f.severity.toLowerCase()));
  if (!hasBlockerTierFinding) return modelRiskLevel;
  return RISK_LEVEL_RANK[modelRiskLevel] >= RISK_LEVEL_RANK.high ? modelRiskLevel : 'high';
}

/** Match-priority rank for `buildRisks`' "highest-severity" tie-break (higher = picked first). */
const SEVERITY_MATCH_RANK: Record<string, number> = { critical: 3, warning: 2, suggestion: 1 };

function severityMatchRank(severity: string): number {
  return SEVERITY_MATCH_RANK[severity.toLowerCase()] ?? 0;
}

/** Lowercase, alphanumeric tokens of a risk-area label (e.g. "Auth flow" -> ["auth", "flow"]). */
function tokenize(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function matchesRiskArea(finding: PostprocessFinding, tokens: readonly string[]): boolean {
  const file = finding.file.toLowerCase();
  const category = finding.category.toLowerCase();
  return tokens.some((token) => file.includes(token) || category.includes(token));
}

/**
 * AC-3/AC-4: build `risks[]` = `intent.riskAreas` verbatim (icon/label
 * unchanged — never re-derived), each optionally carrying a server-attached
 * `fileRef` via the deterministic v1 rule: pick the file+startLine of the
 * highest-severity non-dismissed finding whose `file` path or `category`
 * case-insensitively contains a token of the risk-area's `label`. If no
 * finding matches, OR the top-severity tier is ambiguous (matches point at
 * more than one distinct file:line), `fileRef` is omitted rather than
 * fabricated.
 */
export function buildRisks(
  riskAreas: readonly IntentRiskArea[],
  findings: readonly PostprocessFinding[],
): RiskArea[] {
  const nonDismissed = findings.filter((f) => !f.dismissedAt);

  return riskAreas.map((area): RiskArea => {
    const tokens = tokenize(area.label);
    const candidates = tokens.length === 0 ? [] : nonDismissed.filter((f) => matchesRiskArea(f, tokens));

    if (candidates.length === 0) {
      return { icon: area.icon, label: area.label };
    }

    const topRank = Math.max(...candidates.map((f) => severityMatchRank(f.severity)));
    const topCandidates = candidates.filter((f) => severityMatchRank(f.severity) === topRank);

    const uniqueRefs = new Set(topCandidates.map((f) => `${f.file}:${f.startLine}`));
    if (uniqueRefs.size !== 1) {
      // Never seen (no match) or ambiguous (tie across distinct locations) — never fabricate.
      return { icon: area.icon, label: area.label };
    }

    const winner = topCandidates[0]!;
    return {
      icon: area.icon,
      label: area.label,
      fileRef: { file: winner.file, line: winner.startLine },
    };
  });
}

/**
 * Composed post-processing pipeline in spec order: drop unknown ids (AC-7)
 * -> cap at 8 (AC-9) -> floor riskLevel (AC-14/AC-15) -> build risks[]
 * (AC-3/AC-4). Intended call site: T6's job handler, right after the single
 * `synthesizeBrief` call.
 */
export function postprocessBrief(
  raw: SynthesizedBriefRaw,
  input: {
    findings: readonly PostprocessFinding[];
    riskAreas: readonly IntentRiskArea[];
  },
): PostprocessedBrief {
  const validFindingIds = new Set(input.findings.map((f) => f.id));
  const dropped = dropUnknownFindingIds(raw.reviewFocus, validFindingIds);
  const capped = capReviewFocus(dropped);
  const riskLevel = floorRiskLevel(raw.riskLevel, input.findings);
  const risks = buildRisks(input.riskAreas, input.findings);

  return { what: raw.what, why: raw.why, riskLevel, reviewFocus: capped, risks };
}
