import { describe, it, expect } from 'vitest';
import { OctokitGitHubClient } from './octokit.js';

const REPO = { owner: 'acme', name: 'widgets' };

describe('OctokitGitHubClient.resolveLinkedIssues', () => {
  const client = new OctokitGitHubClient('fake-token');

  it('combines closing-keyword, bare, and full-URL refs, deduplicated', () => {
    const body = 'Closes #12 and see #34, also https://github.com/other/repo/issues/9';
    const result = client.resolveLinkedIssues(body, REPO);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({
      number: 12,
      url: 'https://github.com/acme/widgets/issues/12',
    });
    expect(result).toContainEqual({
      number: 34,
      url: 'https://github.com/acme/widgets/issues/34',
    });
    expect(result).toContainEqual({
      number: 9,
      url: 'https://github.com/other/repo/issues/9',
    });
  });

  it('is case-insensitive on closing keywords', () => {
    const body = 'FIXES #1, Resolved #2, ClOsEd #3';
    const result = client.resolveLinkedIssues(body, REPO);
    expect(result.map((r) => r.number).sort()).toEqual([1, 2, 3]);
  });

  it('caps bare #NN refs at 5 but does not cap closing-keyword refs', () => {
    const body =
      'closes #900, fixes #901, resolves #902, closed #903 — bare: #10 #11 #12 #13 #14 #15 #16';
    const result = client.resolveLinkedIssues(body, REPO);
    const bareNumbers = result.map((r) => r.number).filter((n) => n < 900);
    expect(bareNumbers).toHaveLength(5);
    const keywordNumbers = result.map((r) => r.number).filter((n) => n >= 900);
    expect(keywordNumbers).toHaveLength(4);
  });

  it('deduplicates the same issue referenced both bare and via closing keyword', () => {
    const body = 'closes #12, also mentioned again as #12';
    const result = client.resolveLinkedIssues(body, REPO);
    expect(result).toEqual([{ number: 12, url: 'https://github.com/acme/widgets/issues/12' }]);
  });

  it('returns an empty array when the body has no references', () => {
    expect(client.resolveLinkedIssues('no issues mentioned here', REPO)).toEqual([]);
  });

  it('full GitHub issue URLs may point to a different repo than the current one', () => {
    const body = 'related: https://github.com/other-org/other-repo/issues/42';
    const result = client.resolveLinkedIssues(body, REPO);
    expect(result).toEqual([
      { number: 42, url: 'https://github.com/other-org/other-repo/issues/42' },
    ]);
  });
});

describe('OctokitGitHubClient — private resolveLinkedIssue (single first-match, used by PrDetail.linked_issue)', () => {
  it('preserves original first-#NN-in-document-order semantics via getPullRequest', async () => {
    // `resolveLinkedIssue` is private; exercise it indirectly through getPullRequest
    // so we assert the same observable contract PrDetail.linked_issue depends on:
    // the FIRST #NN in document order wins, regardless of whether a closing
    // keyword precedes it (unlike resolveLinkedIssues' keyword-bucket ordering).
    const client = new OctokitGitHubClient('fake-token');
    const octokit = (client as unknown as { octokit: unknown }).octokit as {
      rest: {
        pulls: {
          get: () => Promise<{ data: Record<string, unknown> }>;
          listFiles: () => Promise<{ data: unknown[] }>;
          listCommits: () => Promise<{ data: unknown[] }>;
        };
        issues: { get: (args: { issue_number: number }) => Promise<{ data: Record<string, unknown> }> };
      };
    };

    octokit.rest.pulls.get = async () => ({
      data: {
        number: 1,
        title: 'Test PR',
        user: { login: 'dev' },
        head: { ref: 'feature', sha: 'abc' },
        base: { ref: 'main' },
        additions: 1,
        deletions: 1,
        changed_files: 1,
        state: 'open',
        merged_at: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        // Bare #5 appears before the closing-keyword #12 in document order.
        body: 'See #5 for context. Closes #12.',
      },
    });
    octokit.rest.pulls.listFiles = async () => ({ data: [] });
    octokit.rest.pulls.listCommits = async () => ({ data: [] });
    octokit.rest.issues.get = async ({ issue_number }) => ({
      data: { number: issue_number, title: `Issue ${issue_number}`, body: '', state: 'open' },
    });

    const detail = await client.getPullRequest(REPO, 1);
    expect(detail.linked_issue?.number).toBe(5);
  });
});
