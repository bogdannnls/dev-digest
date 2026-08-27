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

describe('OctokitGitHubClient — getPullRequest file pagination', () => {
  it('follows pages past 100 files instead of storing a truncated first page', async () => {
    // Regression guard. `listFiles` maxes out at per_page: 100, and a single
    // un-paginated call silently persisted exactly 100 rows for PRs with more
    // changed files than that — while `files_count`, read off the PR object,
    // reported the true total. Nothing failed loudly: reviews read the diff
    // from the local clone, so findings landed on files that were never
    // stored, and only a later `pr_files` lookup surfaced the gap.
    const client = new OctokitGitHubClient('fake-token');
    const octokit = (client as unknown as { octokit: unknown }).octokit as {
      rest: {
        pulls: {
          get: () => Promise<{ data: Record<string, unknown> }>;
          listFiles: (a: { page?: number }) => Promise<{ data: unknown[] }>;
          listCommits: () => Promise<{ data: unknown[] }>;
        };
        issues: { get: (args: { issue_number: number }) => Promise<{ data: Record<string, unknown> }> };
      };
    };

    octokit.rest.pulls.get = async () => ({
      data: {
        number: 1, title: 'Big PR', user: { login: 'dev' },
        head: { ref: 'feature', sha: 'abc' }, base: { ref: 'main' },
        additions: 1, deletions: 1, changed_files: 143, state: 'open', merged_at: null,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', body: '',
      },
    });
    octokit.rest.pulls.listCommits = async () => ({ data: [] });

    // 143 files across two pages: a full 100, then a short 43 that ends it.
    const pagesRequested: number[] = [];
    const file = (i: number) => ({ filename: `src/file-${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@' });
    octokit.rest.pulls.listFiles = async ({ page }) => {
      pagesRequested.push(page ?? 1);
      if (page === 1) return { data: Array.from({ length: 100 }, (_, i) => file(i)) };
      if (page === 2) return { data: Array.from({ length: 43 }, (_, i) => file(100 + i)) };
      return { data: [] };
    };

    const detail = await client.getPullRequest(REPO, 1);

    expect(pagesRequested).toEqual([1, 2]);
    expect(detail.files).toHaveLength(143);
    // The last file only exists beyond the first page — the exact class of
    // path that used to be missing from pr_files.
    expect(detail.files.at(-1)?.path).toBe('src/file-142.ts');
  });

  it('stops after one request when the first page is already short', async () => {
    // The loop must not fire a second, pointless request for a small PR.
    const client = new OctokitGitHubClient('fake-token');
    const octokit = (client as unknown as { octokit: unknown }).octokit as {
      rest: {
        pulls: {
          get: () => Promise<{ data: Record<string, unknown> }>;
          listFiles: (a: { page?: number }) => Promise<{ data: unknown[] }>;
          listCommits: () => Promise<{ data: unknown[] }>;
        };
      };
    };
    octokit.rest.pulls.get = async () => ({
      data: {
        number: 2, title: 'Small PR', user: { login: 'dev' },
        head: { ref: 'f', sha: 'abc' }, base: { ref: 'main' },
        additions: 1, deletions: 1, changed_files: 3, state: 'open', merged_at: null,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', body: '',
      },
    });
    octokit.rest.pulls.listCommits = async () => ({ data: [] });
    let calls = 0;
    octokit.rest.pulls.listFiles = async () => {
      calls += 1;
      return { data: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@' }] };
    };

    await client.getPullRequest(REPO, 2);
    expect(calls).toBe(1);
  });
});
