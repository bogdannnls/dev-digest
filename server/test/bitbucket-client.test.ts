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
