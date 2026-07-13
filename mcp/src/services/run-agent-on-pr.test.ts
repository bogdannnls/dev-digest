import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevDigestPort, Pull, Repo, ReviewDto, RunSummary } from '../domain/ports.js';
import {
  AgentNotFoundError,
  PullNotFoundError,
  RepoNotFoundError,
  RunFailedError,
  RunTimeoutError,
} from '../platform/errors.js';
import { runAgentOnPr, type RunAgentOnPrDeps } from './run-agent-on-pr.js';

function fakePort(overrides: Partial<DevDigestPort> = {}): DevDigestPort {
  return {
    listAgents: async () => [],
    findRepoByFullName: async () => null,
    findPullByNumber: async () => null,
    triggerReview: async () => ({ runId: 'x' }),
    listRunsForPull: async () => [],
    listReviewsForPull: async () => [],
    listConventions: async () => [],
    ...overrides,
  };
}

function sequenced<T>(values: T[]): () => Promise<T> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)]!;
}

const SAMPLE_REPO: Repo = { id: 'repo-1', full_name: 'acme/widgets' };
const SAMPLE_PULL: Pull = { id: 'pull-1', repo_id: 'repo-1', number: 42 };

function makeReview(overrides: Partial<ReviewDto> = {}): ReviewDto {
  return {
    id: 'review-1',
    run_id: 'r1',
    agent_name: 'Security',
    verdict: 'approve',
    score: 90,
    created_at: '2026-01-01T00:00:00.000Z',
    findings: [],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ReviewDto['findings'][number]> = {}) {
  return {
    id: 'finding-1',
    file: 'src/index.ts',
    start_line: 1,
    end_line: 2,
    severity: 'WARNING' as const,
    title: 'Sample finding',
    rationale: 'Because reasons',
    ...overrides,
  };
}

/**
 * Deterministic fake timers: `now` is a mutable counter advanced by `sleep`,
 * so the poll loop's timeout math runs without any real wall-clock waiting.
 */
function fakeDeps(): RunAgentOnPrDeps {
  let currentTime = 0;
  return {
    now: () => currentTime,
    sleep: async (ms: number) => {
      currentTime += ms;
    },
  };
}

describe('runAgentOnPr', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path — clean verdict when approve with zero findings', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: sequenced<RunSummary[]>([
        [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'running' }],
        [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'done' }],
      ]),
      listReviewsForPull: async () => [makeReview({ run_id: 'r1', verdict: 'approve', findings: [] })],
    });

    const result = await runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps());

    expect(result).toEqual({ runId: 'r1', verdict: 'clean', findings: [] });
  });

  it('happy path — issues verdict with concise mapped findings', async () => {
    const findings = [
      makeFinding({ id: 'f1', title: 'Finding 1' }),
      makeFinding({ id: 'f2', title: 'Finding 2' }),
      makeFinding({ id: 'f3', title: 'Finding 3' }),
    ];
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: sequenced<RunSummary[]>([
        [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'running' }],
        [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'done' }],
      ]),
      listReviewsForPull: async () => [
        makeReview({ run_id: 'r1', verdict: 'request_changes', findings }),
      ],
    });

    const result = await runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps());

    expect(result.verdict).toBe('issues');
    expect(result.findings).toEqual([
      {
        file: 'src/index.ts',
        start_line: 1,
        end_line: 2,
        severity: 'WARNING',
        title: 'Finding 1',
        rationale: 'Because reasons',
      },
      {
        file: 'src/index.ts',
        start_line: 1,
        end_line: 2,
        severity: 'WARNING',
        title: 'Finding 2',
        rationale: 'Because reasons',
      },
      {
        file: 'src/index.ts',
        start_line: 1,
        end_line: 2,
        severity: 'WARNING',
        title: 'Finding 3',
        rationale: 'Because reasons',
      },
    ]);
  });

  it('throws RunFailedError with the server error message when run status is failed', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: async () => [
        { run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'failed', error: 'LLM timeout' },
      ],
    });

    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toBeInstanceOf(RunFailedError);
    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toThrow('LLM timeout');
  });

  it('throws RunFailedError with a cancellation message when run status is cancelled', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: async () => [
        { run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'cancelled' },
      ],
    });

    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toBeInstanceOf(RunFailedError);
    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toThrow('cancelled');
  });

  it('throws RunTimeoutError once the poll budget (240000ms) is exceeded', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: async () => [
        { run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'running' },
      ],
    });

    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toBeInstanceOf(RunTimeoutError);
    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toThrow('240000');
  });

  it('propagates AgentNotFoundError from triggerReview and never polls', async () => {
    const listRunsForPull = vi.fn(async () => []);
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => {
        throw new AgentNotFoundError('bad-id');
      },
      listRunsForPull,
    });

    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'bad-id' }, fakeDeps()),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(listRunsForPull).not.toHaveBeenCalled();
  });

  it('throws RepoNotFoundError and never calls findPullByNumber', async () => {
    const findPullByNumber = vi.fn(async () => null);
    const port = fakePort({
      findRepoByFullName: async () => null,
      findPullByNumber,
    });

    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(findPullByNumber).not.toHaveBeenCalled();
  });

  it('throws PullNotFoundError and never calls triggerReview', async () => {
    const triggerReview = vi.fn(async () => ({ runId: 'x' }));
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => null,
      triggerReview,
    });

    await expect(
      runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps()),
    ).rejects.toBeInstanceOf(PullNotFoundError);
    expect(triggerReview).not.toHaveBeenCalled();
  });

  it('truncates findings to 25 with truncated + hint naming get_findings', async () => {
    const manyFindings = Array.from({ length: 30 }, (_, i) =>
      makeFinding({ id: `finding-${i}`, title: `Finding ${i}` }),
    );
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: async () => [
        { run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'done' },
      ],
      listReviewsForPull: async () => [
        makeReview({ run_id: 'r1', verdict: 'comment', findings: manyFindings }),
      ],
    });

    const result = await runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps());

    expect(result.findings).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('get_findings');
  });

  it('race — run not yet materialized on first poll, proceeds without throwing once it appears', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      triggerReview: async () => ({ runId: 'r1' }),
      listRunsForPull: sequenced<RunSummary[]>([
        [],
        [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Security', status: 'done' }],
      ]),
      listReviewsForPull: async () => [makeReview({ run_id: 'r1', verdict: 'approve', findings: [] })],
    });

    const result = await runAgentOnPr(port, { repo: 'acme/widgets', pr: 42, agent: 'a1' }, fakeDeps());

    expect(result).toEqual({ runId: 'r1', verdict: 'clean', findings: [] });
  });
});
