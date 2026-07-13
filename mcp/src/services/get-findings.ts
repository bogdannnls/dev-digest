/**
 * `getFindings` — service backing the `get_findings` tool.
 *
 * Flow: resolve `repo` (full_name `owner/name`) + `pr` (PR number) to a
 * `Pull`, then list reviews for it. With no `agent` filter, picks the most
 * recent review by `created_at`. With an `agent` filter, narrows to reviews
 * whose `agent_name` matches first — an empty result after filtering (with
 * reviews present) means the agent name doesn't match any reviewer that ran
 * on this PR, which is an error (`AgentNotFoundError`, forward to
 * `list_agents`). No reviews at all is a valid empty state either way —
 * returns `{ verdict: null, findings: [] }` rather than throwing.
 *
 * **Verdict passthrough**: this service returns the server's raw `Verdict`
 * (`'approve' | 'request_changes' | 'comment' | null`) untouched.
 * `run_agent_on_pr` (T7) is the one that collapses it to the tool's 3-state
 * `clean`/`issues`/`error`; `get_findings` stays the source-of-truth view for
 * downstream tools/agents to interpret themselves.
 *
 * Errors (e.g. `ApiUnreachableError` from the port) are not caught here —
 * they propagate to the tool handler registered in T9, which centrally
 * converts typed errors into MCP error content (rule A2 — this file never
 * does `throw new Error(...)`).
 */

import type { DevDigestPort, Finding, ReviewDto, Verdict } from '../domain/ports.js';
import { AgentNotFoundError, PullNotFoundError, RepoNotFoundError } from '../platform/errors.js';

/** Rule P-concise — cap the findings array so large reviews don't blow the response budget. */
const TRUNCATION_LIMIT = 25;

export interface GetFindingsInput {
  repo: string;
  pr: number;
  agent?: string;
}

export interface ConciseFinding {
  file: string;
  start_line: number;
  end_line: number;
  severity: Finding['severity'];
  title: string;
  rationale: string;
}

export interface GetFindingsResult {
  verdict: Verdict | null;
  findings: ConciseFinding[];
  truncated?: boolean;
  hint?: string;
}

export async function getFindings(
  port: DevDigestPort,
  input: GetFindingsInput,
): Promise<GetFindingsResult> {
  const repo = await port.findRepoByFullName(input.repo);
  if (!repo) throw new RepoNotFoundError(input.repo);

  const pull = await port.findPullByNumber(repo.id, input.pr);
  if (!pull) throw new PullNotFoundError(input.pr, input.repo);

  const reviews = await port.listReviewsForPull(pull.id);

  const filtered = input.agent
    ? reviews.filter((r) => r.agent_name === input.agent)
    : reviews;

  if (input.agent && filtered.length === 0 && reviews.length > 0) {
    throw new AgentNotFoundError(input.agent);
  }

  if (filtered.length === 0) {
    return { verdict: null, findings: [] };
  }

  const mostRecent = pickMostRecent(filtered);

  const findings = mostRecent.findings.map(toConciseFinding);
  const truncated = findings.length > TRUNCATION_LIMIT;

  return {
    verdict: mostRecent.verdict,
    findings: truncated ? findings.slice(0, TRUNCATION_LIMIT) : findings,
    ...(truncated
      ? {
          truncated: true as const,
          hint: 'pass a narrower agent filter to get_findings to reduce the set',
        }
      : {}),
  };
}

function pickMostRecent(reviews: ReviewDto[]): ReviewDto {
  return reviews.reduce((latest, current) =>
    new Date(current.created_at).getTime() > new Date(latest.created_at).getTime()
      ? current
      : latest,
  );
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
