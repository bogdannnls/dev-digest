/**
 * `DevDigestPort` — the seam services depend on. Implemented by
 * `adapters/http-devdigest.ts` (T3); consumed by `services/*` (T4-T8).
 *
 * Interface only, no implementation — keeps `services/*` decoupled from
 * `fetch`/HTTP details (rule A1).
 */

import type {
  Agent,
  ConventionCandidate,
  Pull,
  Repo,
  ReviewDto,
  RunSummary,
} from './types.js';

export type {
  Agent,
  ConventionCandidate,
  Finding,
  Pull,
  Repo,
  ReviewDto,
  RunResult,
  RunSummary,
  Verdict,
} from './types.js';

export interface DevDigestPort {
  listAgents(): Promise<Agent[]>;
  findRepoByFullName(fullName: string): Promise<Repo | null>;
  findPullByNumber(repoId: string, prNumber: number): Promise<Pull | null>;
  triggerReview(pullId: string, agentId: string): Promise<{ runId: string }>;
  listRunsForPull(pullId: string): Promise<RunSummary[]>;
  listReviewsForPull(pullId: string): Promise<ReviewDto[]>;
  listConventions(repoId: string): Promise<ConventionCandidate[]>;
}
