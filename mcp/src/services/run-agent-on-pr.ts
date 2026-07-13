/**
 * `runAgentOnPr` — service backing the `run_agent_on_pr` tool.
 *
 * Rule P-result — this tool triggers a review, polls it to completion, and
 * returns the final findings in one call; callers never see an intermediate
 * run handle.
 *
 * Flow: resolve `repo` (full_name `owner/name`) + `pr` (PR number) to a
 * `Pull` (typed errors on miss, matching `get-findings.ts`'s pattern), then
 * `port.triggerReview(pullId, agent)` passing `agent` straight through as an
 * agentId — **no name-fallback** (locked decision; the id-only contract
 * means whatever string the caller passes goes to the adapter, which maps a
 * server-side rejection to `AgentNotFoundError`). Then polls
 * `port.listRunsForPull(pullId)` until the matching run leaves `'running'`,
 * and finally fetches the matching review from `port.listReviewsForPull`.
 *
 * **Poll timeout budget**: 240s. Per `server/INSIGHTS.md` (2026-07-04,
 * "`withIdleTimeout` is not a strict upgrade over `withTimeout`"), the
 * server's own LLM-call idle timeout was raised from 60s to 180s because
 * TTFB counts against idle time under Anthropic rate-limit queuing. This
 * poll loop's timeout must exceed the server's own timeout budget, so it's
 * set to 240s (180s + margin) rather than reusing the poll interval alone.
 *
 * **Race-freedom**: per `server/INSIGHTS.md` (2026-06-24, "SSE 'done' must
 * be emitted by the layer that commits the side effect"), the server only
 * flips a run's status away from `'running'` after its DB write has
 * committed — so polling `GET /pulls/:id/runs` until `status !== 'running'`
 * is race-free with respect to the review data being readable afterward.
 * The one real race is the sub-second window between `triggerReview`
 * returning a `runId` and the run row being materialized in
 * `listRunsForPull` at all; that's handled by treating a missing row as
 * still-running rather than as an error (see the loop below).
 *
 * Errors not explicitly handled here (e.g. `ApiUnreachableError` from the
 * port) propagate to the tool handler registered in T9, which centrally
 * converts typed errors into MCP error content (rule A2 — this file never
 * does `throw new Error(...)`).
 */

import type { DevDigestPort, Finding, ReviewDto } from '../domain/ports.js';
import {
  AgentNotFoundError,
  PullNotFoundError,
  RepoNotFoundError,
  RunFailedError,
  RunTimeoutError,
} from '../platform/errors.js';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 240_000; // per server/INSIGHTS.md 2026-07-04 idle-timeout entry
const TRUNCATION_LIMIT = 25;

export interface RunAgentOnPrInput {
  repo: string;
  pr: number;
  agent: string; // id ONLY — no name-fallback (locked decision)
}

export interface RunAgentOnPrDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ConciseFinding {
  file: string;
  start_line?: number;
  end_line?: number;
  severity: Finding['severity'];
  title: string;
  rationale: string;
}

export interface RunAgentOnPrResult {
  runId: string;
  verdict: 'clean' | 'issues' | 'error';
  findings: ConciseFinding[];
  truncated?: true;
  hint?: string;
}

export async function runAgentOnPr(
  port: DevDigestPort,
  input: RunAgentOnPrInput,
  deps: RunAgentOnPrDeps,
): Promise<RunAgentOnPrResult> {
  const repo = await port.findRepoByFullName(input.repo);
  if (!repo) throw new RepoNotFoundError(input.repo);

  const pull = await port.findPullByNumber(repo.id, input.pr);
  if (!pull) throw new PullNotFoundError(input.pr, input.repo);

  const { runId } = await port.triggerReview(pull.id, input.agent);

  await pollUntilSettled(port, pull.id, runId, deps);

  const reviews = await port.listReviewsForPull(pull.id);
  const review = reviews.find((r) => r.run_id === runId);
  if (!review) {
    throw new RunFailedError(runId, 'review missing after run reported done');
  }

  const findings = review.findings.map(toConciseFinding);
  const truncated = findings.length > TRUNCATION_LIMIT;

  return {
    runId,
    verdict: toVerdict(review),
    findings: truncated ? findings.slice(0, TRUNCATION_LIMIT) : findings,
    ...(truncated
      ? {
          truncated: true as const,
          hint: 'call get_findings with the same repo/pr/agent to page through the remaining findings',
        }
      : {}),
  };
}

/**
 * Polls `port.listRunsForPull` every `POLL_INTERVAL_MS` until the run
 * matching `runId` leaves the `'running'` state, or throws on failure /
 * cancellation / timeout.
 */
async function pollUntilSettled(
  port: DevDigestPort,
  pullId: string,
  runId: string,
  deps: RunAgentOnPrDeps,
): Promise<void> {
  const startedAt = deps.now();

  for (;;) {
    const runs = await port.listRunsForPull(pullId);
    const target = runs.find((r) => r.run_id === runId);

    // Missing row = benign race in the sub-second window right after
    // triggerReview, before the server materializes the run — treat as
    // still-running, not an error.
    if (target?.status === 'done') {
      return;
    }
    if (target?.status === 'failed') {
      throw new RunFailedError(runId, target.error ?? 'no error message');
    }
    if (target?.status === 'cancelled') {
      throw new RunFailedError(runId, 'run cancelled');
    }

    if (deps.now() - startedAt >= POLL_TIMEOUT_MS) {
      throw new RunTimeoutError(runId, POLL_TIMEOUT_MS);
    }

    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Verdict mapping (server enum → tool 3-state):
 *   - `approve` + zero findings          → `clean`
 *   - `approve` + non-zero findings      → `issues`
 *   - `request_changes` / `comment`      → `issues`
 *   - anything unexpected                → `error` (defensive)
 */
function toVerdict(review: ReviewDto): 'clean' | 'issues' | 'error' {
  switch (review.verdict) {
    case 'approve':
      return review.findings.length === 0 ? 'clean' : 'issues';
    case 'request_changes':
    case 'comment':
      return 'issues';
    default:
      return 'error';
  }
}

function toConciseFinding(f: Finding): ConciseFinding {
  return {
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    severity: f.severity,
    title: f.title,
    rationale: f.rationale,
  };
}
