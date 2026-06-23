import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BitbucketClient } from '../src/adapters/bitbucket/rest.js';

const REPO = { owner: 'myws', name: 'myrepo' };

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('BitbucketClient (OAuth token)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: BitbucketClient;

  beforeEach(() => {
    client = new BitbucketClient({ token: 'test_token' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('currentLogin returns nickname', async () => {
    fetchSpy = mockFetch({ nickname: 'bbuser', display_name: 'BB User' });
    vi.stubGlobal('fetch', fetchSpy);
    const login = await client.currentLogin();
    expect(login).toBe('bbuser');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/user'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test_token' }) }),
    );
  });

  it('listPullRequests maps Bitbucket PR state to PrStatus', async () => {
    fetchSpy = mockFetch({
      values: [
        {
          id: 1,
          title: 'Test PR',
          author: { display_name: 'Dev', nickname: 'dev' },
          source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } },
          destination: { branch: { name: 'main' } },
          state: 'OPEN',
          created_on: '2024-01-01T00:00:00Z',
          updated_on: '2024-01-02T00:00:00Z',
          links: { html: { href: 'https://bitbucket.org/myws/myrepo/pull-requests/1' } },
        },
      ],
      next: undefined,
    });
    vi.stubGlobal('fetch', fetchSpy);
    const prs = await client.listPullRequests(REPO);
    expect(prs).toHaveLength(1);
    expect(prs[0]!.number).toBe(1);
    expect(prs[0]!.status).toBe('open');
    expect(prs[0]!.branch).toBe('feature');
  });

  it('listPullRequests maps MERGED state', async () => {
    fetchSpy = mockFetch({
      values: [
        {
          id: 2, title: 'Merged', author: { nickname: 'dev' },
          source: { branch: { name: 'fix' }, commit: { hash: 'def456' } },
          destination: { branch: { name: 'main' } },
          state: 'MERGED',
          created_on: '2024-01-01T00:00:00Z',
          updated_on: '2024-01-01T00:00:00Z',
          links: { html: { href: '' } },
        },
      ],
    });
    vi.stubGlobal('fetch', fetchSpy);
    const prs = await client.listPullRequests(REPO);
    expect(prs[0]!.status).toBe('merged');
  });

  it('throws AppError on 401', async () => {
    fetchSpy = mockFetch({ error: { message: 'Unauthorized' } }, 401);
    vi.stubGlobal('fetch', fetchSpy);
    await expect(client.currentLogin()).rejects.toMatchObject({ code: 'unauthorized', statusCode: 401 });
  });

  it('throws AppError on 404', async () => {
    fetchSpy = mockFetch({ error: { message: 'Not found' } }, 404);
    vi.stubGlobal('fetch', fetchSpy);
    await expect(client.getIssue(REPO, 999)).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
  });

  it('getPullRequest returns detail with file patches', async () => {
    const prResponse = {
      id: 1, title: 'Test PR',
      author: { nickname: 'dev' },
      source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } },
      destination: { branch: { name: 'main' } },
      state: 'OPEN',
      created_on: '2024-01-01T00:00:00Z',
      updated_on: '2024-01-02T00:00:00Z',
      description: 'fixes #5',
    };
    const diffstatResponse = {
      values: [{ new: { path: 'src/foo.ts' }, lines_added: 2, lines_removed: 1 }],
    };
    const diffText = 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const commitsResponse = {
      values: [{
        hash: 'abc123', message: 'feat: add thing', date: '2024-01-01T00:00:00Z',
        author: { user: { nickname: 'dev' } },
      }],
    };
    const issueResponse = {
      id: 5, title: 'The issue', content: { raw: 'desc' }, state: 'open',
    };

    fetchSpy = vi.fn().mockImplementation((url: string) => {
      // Order matters: /diffstat must be checked before /diff to avoid substring collision
      if (url.includes('/diffstat')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(diffstatResponse) });
      }
      // /diff endpoint returns text/plain (not JSON)
      if (url.includes('/pullrequests/1/diff')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(diffText) });
      }
      if (url.includes('/commits')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(commitsResponse) });
      }
      if (url.includes('/issues/5')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(issueResponse) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(prResponse) });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const detail = await client.getPullRequest(REPO, 1);
    expect(detail.number).toBe(1);
    expect(detail.files).toHaveLength(1);
    expect(detail.files[0]!.path).toBe('src/foo.ts');
    expect(detail.files[0]!.patch).not.toBeNull();
    expect(detail.commits).toHaveLength(1);
    expect(detail.linked_issue?.number).toBe(5);
  });

  it('findOpenPr encodes branch name correctly', async () => {
    fetchSpy = mockFetch({ values: [{ links: { html: { href: 'https://bb.org/pr/1' } } }] });
    vi.stubGlobal('fetch', fetchSpy);
    const result = await client.findOpenPr(REPO, 'feature/my-branch');
    expect(result?.url).toBe('https://bb.org/pr/1');
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    // Verify the branch name is properly encoded in the query
    expect(calledUrl).toContain('q=');
    expect(calledUrl).not.toContain('feature/my-branch'); // slash should be encoded
  });

  it('listReviewComments returns only inline comments', async () => {
    fetchSpy = mockFetch({
      values: [
        {
          id: 1, content: { raw: 'inline comment' }, created_on: '2024-01-01T00:00:00Z',
          author: { nickname: 'dev' },
          inline: { path: 'src/foo.ts', to: 10 },
          links: { html: { href: 'https://bb.org/comment/1' } },
        },
        {
          id: 2, content: { raw: 'general comment' }, created_on: '2024-01-01T00:00:00Z',
          author: { nickname: 'dev' },
          links: { html: { href: 'https://bb.org/comment/2' } },
          // no inline field
        },
      ],
    });
    vi.stubGlobal('fetch', fetchSpy);
    const comments = await client.listReviewComments(REPO, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.path).toBe('src/foo.ts');
    expect(comments[0]!.line).toBe(10);
  });
});

describe('BitbucketClient (App Password)', () => {
  it('uses Basic auth header', async () => {
    const client = new BitbucketClient({ username: 'user', appPassword: 'pass' });
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    const fetchSpy = mockFetch({ nickname: 'user' });
    vi.stubGlobal('fetch', fetchSpy);
    await client.currentLogin();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expected }) }),
    );
    vi.restoreAllMocks();
  });

  it('throws if neither token nor username+appPassword supplied', () => {
    expect(() => new BitbucketClient({})).toThrow();
  });
});
