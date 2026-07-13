import { describe, expect, it, vi } from 'vitest';
import type { DevDigestPort, Finding, Pull, Repo, ReviewDto } from '../domain/ports.js';
import { AgentNotFoundError, PullNotFoundError, RepoNotFoundError } from '../platform/errors.js';
import { getFindings } from './get-findings.js';

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

const SAMPLE_REPO: Repo = { id: 'repo-1', full_name: 'acme/widgets' };
const SAMPLE_PULL: Pull = { id: 'pull-1', repo_id: 'repo-1', number: 42 };

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding-1',
    file: 'src/index.ts',
    start_line: 1,
    end_line: 2,
    severity: 'WARNING',
    title: 'Sample finding',
    rationale: 'Because reasons',
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewDto> = {}): ReviewDto {
  return {
    id: 'review-1',
    run_id: 'run-1',
    agent_name: 'Security',
    verdict: 'approve',
    score: 90,
    created_at: '2026-01-01T00:00:00.000Z',
    findings: [],
    ...overrides,
  };
}

describe('getFindings', () => {
  it('returns { verdict: null, findings: [] } when no reviews exist yet (valid empty state)', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      listReviewsForPull: async () => [],
    });

    const result = await getFindings(port, { repo: 'acme/widgets', pr: 42 });

    expect(result).toEqual({ verdict: null, findings: [] });
  });

  it('with multiple reviews and no agent filter, picks the most recent by created_at', async () => {
    const oldest = makeReview({
      id: 'review-old',
      run_id: 'run-old',
      created_at: '2026-01-01T00:00:00.000Z',
      verdict: 'request_changes',
      findings: [makeFinding({ title: 'Old finding' })],
    });
    const middle = makeReview({
      id: 'review-mid',
      run_id: 'run-mid',
      created_at: '2026-01-02T00:00:00.000Z',
      verdict: 'comment',
      findings: [makeFinding({ title: 'Mid finding' })],
    });
    const newest = makeReview({
      id: 'review-new',
      run_id: 'run-new',
      created_at: '2026-01-03T00:00:00.000Z',
      verdict: 'approve',
      findings: [
        makeFinding({
          id: 'f-new',
          file: 'src/new.ts',
          start_line: 10,
          end_line: 12,
          severity: 'CRITICAL',
          title: 'New finding',
          rationale: 'New rationale',
        }),
      ],
    });

    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      // Deliberately out of chronological order to prove sort-by-created_at, not array order.
      listReviewsForPull: async () => [middle, newest, oldest],
    });

    const result = await getFindings(port, { repo: 'acme/widgets', pr: 42 });

    expect(result).toEqual({
      verdict: 'approve',
      findings: [
        {
          file: 'src/new.ts',
          start_line: 10,
          end_line: 12,
          severity: 'CRITICAL',
          title: 'New finding',
          rationale: 'New rationale',
        },
      ],
    });
  });

  it('with an agent filter matching one review, returns that review’s data', async () => {
    const securityReview = makeReview({
      id: 'review-security',
      run_id: 'run-security',
      agent_name: 'Security',
      created_at: '2026-01-02T00:00:00.000Z',
      verdict: 'request_changes',
      findings: [makeFinding({ title: 'Security finding' })],
    });
    const styleReview = makeReview({
      id: 'review-style',
      run_id: 'run-style',
      agent_name: 'Style',
      created_at: '2026-01-03T00:00:00.000Z',
      verdict: 'comment',
      findings: [makeFinding({ title: 'Style finding' })],
    });
    const perfReview = makeReview({
      id: 'review-perf',
      run_id: 'run-perf',
      agent_name: 'Performance',
      created_at: '2026-01-01T00:00:00.000Z',
      verdict: 'approve',
      findings: [],
    });

    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      listReviewsForPull: async () => [securityReview, styleReview, perfReview],
    });

    const result = await getFindings(port, { repo: 'acme/widgets', pr: 42, agent: 'Security' });

    expect(result).toEqual({
      verdict: 'request_changes',
      findings: [
        {
          file: 'src/index.ts',
          start_line: 1,
          end_line: 2,
          severity: 'WARNING',
          title: 'Security finding',
          rationale: 'Because reasons',
        },
      ],
    });
  });

  it('throws AgentNotFoundError with the agent name when the filter matches no review (reviews present)', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      listReviewsForPull: async () => [makeReview({ agent_name: 'Security' })],
    });

    await expect(
      getFindings(port, { repo: 'acme/widgets', pr: 42, agent: 'Unknown' }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(
      getFindings(port, { repo: 'acme/widgets', pr: 42, agent: 'Unknown' }),
    ).rejects.toThrow('Unknown');
  });

  it('truncates findings to 25 and includes truncated + hint referencing agent filtering', async () => {
    const manyFindings = Array.from({ length: 30 }, (_, i) =>
      makeFinding({ id: `finding-${i}`, title: `Finding ${i}` }),
    );
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      listReviewsForPull: async () => [makeReview({ findings: manyFindings })],
    });

    const result = await getFindings(port, { repo: 'acme/widgets', pr: 42 });

    expect(result.findings).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('agent');
  });

  it('does not truncate or set truncated/hint when findings are within the limit', async () => {
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => SAMPLE_PULL,
      listReviewsForPull: async () => [makeReview({ findings: [makeFinding()] })],
    });

    const result = await getFindings(port, { repo: 'acme/widgets', pr: 42 });

    expect(result.findings).toHaveLength(1);
    expect(result.truncated).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it('throws RepoNotFoundError when the repo is not found', async () => {
    const port = fakePort({ findRepoByFullName: async () => null });

    await expect(getFindings(port, { repo: 'acme/widgets', pr: 42 })).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
  });

  it('throws PullNotFoundError when the PR is not found, and never calls listReviewsForPull', async () => {
    const listReviewsForPull = vi.fn(async () => []);
    const port = fakePort({
      findRepoByFullName: async () => SAMPLE_REPO,
      findPullByNumber: async () => null,
      listReviewsForPull,
    });

    await expect(getFindings(port, { repo: 'acme/widgets', pr: 42 })).rejects.toBeInstanceOf(
      PullNotFoundError,
    );
    expect(listReviewsForPull).not.toHaveBeenCalled();
  });
});
