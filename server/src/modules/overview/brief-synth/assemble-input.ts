/**
 * `assembleBriefInput` — the input-gathering step for the Why + Risk Brief
 * synthesis call (SPEC-02). Pure composition over ALREADY-COMPUTED artifacts
 * (Intent, `RepoIntel.getBlastRadius`, latest-review findings, `SmartDiff`,
 * attached-spec paths) — no re-derivation of any of them (Non-goals).
 *
 * Grounding-safety contract enforced here (see
 * `server/src/prompts/brief-synth.system.md` for the matching
 * untrusted-content clause consumed by T5's synthesis call):
 *   - NO diff/patch body content anywhere in the returned shape (AC-5).
 *   - Attached specs carry `path`/`title` ONLY, never document bodies (AC-6).
 *   - Each finding's `rationale` is clipped to a fixed character budget so
 *     total prompt size stays bounded regardless of finding count (AC-12).
 *   - Findings with a non-null `dismissedAt` are excluded from the candidate
 *     set (AC-8).
 *   - "Latest review" is resolved via the SAME shared helper
 *     `_shared/latest-review.ts` that `computeFindingsByPr` uses — never an
 *     independently re-derived definition (AC-11).
 *
 * Precondition: the caller (the service, T6) must already have confirmed a
 * `pr_intent` row and a qualifying latest review both exist (the AC-16..18
 * `not_ready` gate) before calling this. Missing either throws
 * `NotFoundError` — this function is a composer, not the readiness gate.
 *
 * See specs/2026-07-13-why-risk-brief-spec.md and
 * docs/superpowers/plans/2026-07-13-why-risk-brief-plan.md (T3).
 */
import { basename } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { IntentReferenceDto, RiskAreaIcon, SmartDiff } from '@devdigest/shared';
import * as t from '../../../db/schema.js';
import type { Container } from '../../../platform/container.js';
import { NotFoundError } from '../../../platform/errors.js';
import { IntentRepository } from '../intent/repository.js';
import { latestReviewForPr, type LatestReviewRow } from '../../_shared/latest-review.js';
import { composeSmartDiff, type ComposerFile, type ComposerFinding } from '../../_shared/smart-diff.js';
// Type-only import of the RepoIntel port's declared return type
// (`container.repoIntel.getBlastRadius()`) — `_shared/ports.ts` does not
// currently define/re-export a RepoIntel port surface, so this stays a
// direct type-only import from the owning module (no runtime coupling).
import type { BlastResult } from '../../repo-intel/types.js';

/**
 * Per-finding character budget for `rationale` (AC-12) — bounds total prompt
 * size regardless of how many findings the PR has, rather than dropping
 * findings once a total budget is exceeded.
 */
export const RATIONALE_CLIP_CHARS = 400;

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** A non-dismissed finding, shaped for the synthesis prompt (AC-8, AC-12). */
export interface AssembledFinding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
  /** Clipped to `RATIONALE_CLIP_CHARS` (AC-12) — never dropped, only shortened. */
  rationale: string;
}

/** The PR's cached intent, read (never recomputed) — goal/scope/riskAreas/references only. */
export interface AssembledIntent {
  goal: string;
  inScope: string[];
  outOfScope: string[];
  riskAreas: { icon: RiskAreaIcon; label: string }[];
  references: IntentReferenceDto[];
}

/** Attached-context document reference — path + title ONLY, never body content (AC-6). */
export interface AttachedSpecRef {
  path: string;
  title: string;
}

/**
 * The freshness key this input was gathered against — same shape as
 * `BriefSynthUpsertKey` (`repository.ts`, T4) so the service (T6) can persist
 * exactly what was used to compute, with no second derivation.
 */
export interface BriefSynthBasedOnKey {
  headSha: string;
  reviewId: string;
  intentComputedAt: string;
}

export interface BriefSynthInput {
  basedOn: BriefSynthBasedOnKey;
  intent: AssembledIntent;
  /** Non-dismissed findings for the latest review (AC-8, AC-11). */
  findings: AssembledFinding[];
  /** `RepoIntel.getBlastRadius` result, as-is — existing facade, no new algorithm (Non-goal). */
  blast: BlastResult;
  /** `composeSmartDiff` output — file-level stats only, never raw diff/patch bodies (AC-5). */
  diffStats: SmartDiff;
  /** Reviewing agent's attached-context set — path/title only, never body content (AC-6). */
  attachedSpecs: AttachedSpecRef[];
}

export async function assembleBriefInput(
  container: Container,
  workspaceId: string,
  prId: string,
): Promise<BriefSynthInput> {
  const [pr] = await container.db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
  if (!pr) throw new NotFoundError('Pull request not found');

  const intentRow = await new IntentRepository(container.db).get(prId);
  if (!intentRow) {
    throw new NotFoundError(
      'PR intent not found — caller must confirm readiness (AC-16) before assembling brief input',
    );
  }

  const review = await latestReviewForPr(container.db, prId);
  if (!review) {
    throw new NotFoundError(
      'No qualifying review found — caller must confirm readiness (AC-17) before assembling brief input',
    );
  }

  const findings = await loadFindings(container, review.id);

  const fileRows = await container.db
    .select({
      path: t.prFiles.path,
      additions: t.prFiles.additions,
      deletions: t.prFiles.deletions,
    })
    .from(t.prFiles)
    .where(eq(t.prFiles.prId, prId));

  const composerFiles: ComposerFile[] = fileRows.map((f) => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
  }));
  const composerFindings: ComposerFinding[] = findings.map((f) => ({
    file: f.file,
    start_line: f.startLine,
  }));
  const diffStats = composeSmartDiff(composerFiles, composerFindings);

  const changedFiles = fileRows.map((f) => f.path);
  const blast = await container.repoIntel.getBlastRadius(pr.repoId, changedFiles);

  const attachedSpecs = await resolveAttachedSpecs(container, workspaceId, pr.repoId, review);

  return {
    basedOn: {
      headSha: pr.headSha,
      reviewId: review.id,
      intentComputedAt: intentRow.data.computedAt,
    },
    intent: {
      goal: intentRow.data.goal,
      inScope: intentRow.data.inScope,
      outOfScope: intentRow.data.outOfScope,
      riskAreas: intentRow.data.riskAreas,
      references: intentRow.data.references,
    },
    findings,
    blast,
    diffStats,
    attachedSpecs,
  };
}

/**
 * Non-dismissed findings for a review (AC-8), rationale-clipped (AC-12).
 * Scoped to `reviewId` and dismissal both re-checked in application code
 * (not left to the SQL `WHERE` alone) so each rule is a single, independently
 * testable statement regardless of the underlying query shape.
 */
async function loadFindings(container: Container, reviewId: string): Promise<AssembledFinding[]> {
  const rows = await container.db
    .select({
      id: t.findings.id,
      reviewId: t.findings.reviewId,
      file: t.findings.file,
      startLine: t.findings.startLine,
      endLine: t.findings.endLine,
      severity: t.findings.severity,
      category: t.findings.category,
      title: t.findings.title,
      rationale: t.findings.rationale,
      dismissedAt: t.findings.dismissedAt,
    })
    .from(t.findings)
    .where(eq(t.findings.reviewId, reviewId));

  return rows
    .filter((f) => f.reviewId === reviewId && f.dismissedAt == null)
    .map((f) => ({
      id: f.id,
      file: f.file,
      startLine: f.startLine,
      endLine: f.endLine,
      severity: f.severity,
      category: f.category,
      title: f.title,
      rationale: clip(f.rationale, RATIONALE_CLIP_CHARS),
    }));
}

/**
 * Attached-context set for the reviewing agent — path + title ONLY (AC-6),
 * title = file basename for v1 (no heading parse, per plan M4). Mirrors the
 * effective-set construction in `reviews/run-executor.ts`'s `buildSpecsDigest`
 * (agent's own paths, then each ENABLED linked skill's paths, first-occurrence
 * wins) but is FAIL-SOFT, not fail-closed: this is a best-effort synthesis
 * input, not a pre-flight gate for an LLM review run, so a missing clone or a
 * since-renamed/deleted path just yields fewer entries, never a thrown error.
 *
 * Empty when the latest review has no `agentId` (agents are deletable) or
 * the agent row itself no longer exists (M4).
 */
async function resolveAttachedSpecs(
  container: Container,
  workspaceId: string,
  repoId: string,
  review: LatestReviewRow,
): Promise<AttachedSpecRef[]> {
  if (!review.agentId) return [];

  const agent = await container.agentsRepo.getById(workspaceId, review.agentId);
  if (!agent) return [];

  const seen = new Set<string>();
  const effective: string[] = [];
  const addAll = (paths: string[] | null | undefined) => {
    for (const p of paths ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      effective.push(p);
    }
  };
  addAll(agent.attachedContextPaths);
  const linkedSkills = await container.agentsRepo.linkedSkills(agent.id);
  for (const link of linkedSkills) {
    if (!link.enabled) continue;
    addAll(link.skill.attachedContextPaths);
  }
  if (effective.length === 0) return [];

  const known = await container.context.listPaths(workspaceId, repoId);
  if (known === null) return [];

  return effective.filter((p) => known.has(p)).map((p) => ({ path: p, title: basename(p) }));
}
