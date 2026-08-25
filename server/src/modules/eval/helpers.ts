import type { EvalBatchRecord, EvalCase, EvalRunRecord } from '@devdigest/shared';
import type { EvalCaseRow, EvalRunBatchRow, EvalRunRow } from './repository.js';

/** DB row → wire `EvalCase` (§1.1 — `input_files` is always null for this feature). */
export function toEvalCaseDto(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    name: row.name,
    input_diff: row.inputDiff ?? '',
    input_files: row.inputFiles,
    input_meta: row.inputMeta,
    expected_output: row.expectedOutput,
    notes: row.notes,
  };
}

/** DB row → wire `EvalBatchRecord` (§2.4 — deliberately omits `system_prompt`). */
export function toEvalBatchRecordDto(row: EvalRunBatchRow): EvalBatchRecord {
  return {
    id: row.id,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    agent_version: row.agentVersion,
    model: row.model,
    provider: row.provider,
    ran_at: row.ranAt.toISOString(),
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status,
    cases_total: row.casesTotal,
    traces_passed: row.tracesPassed,
    recall: row.recall,
    precision: row.precision,
    citation_accuracy: row.citationAccuracy,
    duration_ms: row.durationMs,
    cost_usd: row.costUsd,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    error: row.error,
  };
}

/** DB row (+ joined case name) → wire `EvalRunRecord` (§2.5). `recall`/`precision`/
 *  `citation_accuracy` stay null on every per-case row — those ratios are
 *  batch-level only (§3.3); a single case has no denominator to divide by. */
export function toEvalRunRecordDto(row: EvalRunRow & { caseName: string | null }): EvalRunRecord {
  return {
    id: row.id,
    case_id: row.caseId,
    case_name: row.caseName,
    ran_at: row.ranAt.toISOString(),
    actual_output: row.actualOutput,
    pass: row.pass,
    recall: row.recall,
    precision: row.precision,
    citation_accuracy: row.citationAccuracy,
    duration_ms: row.durationMs,
    cost_usd: row.costUsd,
  };
}

/** Slugify a finding title into a name-safe token (contract §4.4 step 5).
 *  De-duplication (`-2`, `-3`, ...) is the caller's job via `dedupeCaseName`. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'case';
}

/** Append `-2`, `-3`, ... until `base` doesn't collide with `existingNames`. */
export function dedupeCaseName(base: string, existingNames: ReadonlySet<string>): string {
  if (!existingNames.has(base)) return base;
  let i = 2;
  while (existingNames.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/** `b - a`, or `null` when either side is `null` (contract §2.6/§2.8). */
export function metricDelta(b: number | null, a: number | null): number | null {
  return a == null || b == null ? null : b - a;
}

/** One-line regression alert (contract §4.3): non-null when any of
 *  recall/precision/citation_accuracy dropped by >= 0.02 between the two
 *  newest batches; `null` when neither batch exists or nothing regressed. */
export function computeAlert(
  newest: Pick<EvalRunBatchRow, 'recall' | 'precision' | 'citationAccuracy'> | undefined,
  previous: Pick<EvalRunBatchRow, 'recall' | 'precision' | 'citationAccuracy'> | undefined,
): string | null {
  if (!newest || !previous) return null;
  const regressions: string[] = [];
  const check = (label: string, key: 'recall' | 'precision' | 'citationAccuracy') => {
    const n = newest[key];
    const p = previous[key];
    if (n == null || p == null) return;
    const drop = p - n;
    if (drop >= 0.02) regressions.push(`${label} dropped by ${drop.toFixed(2)}`);
  };
  check('recall', 'recall');
  check('precision', 'precision');
  check('citation accuracy', 'citationAccuracy');
  return regressions.length > 0 ? regressions.join('; ') : null;
}
