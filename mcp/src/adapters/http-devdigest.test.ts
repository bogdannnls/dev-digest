import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpDevDigestAdapter } from './http-devdigest.js';
import { AgentNotFoundError, ApiUnreachableError } from '../platform/errors.js';

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, init: { status: number; statusText?: string }): Response {
  return new Response(text, {
    status: init.status,
    statusText: init.statusText ?? '',
  });
}

describe('HttpDevDigestAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('URL construction', () => {
    it('uses default base URL when DEVDIGEST_API_URL is unset', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({});
      await adapter.listAgents();
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3001/agents', expect.anything());
    });

    it('uses custom base URL from env', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({ DEVDIGEST_API_URL: 'http://custom.local:9000' });
      await adapter.listAgents();
      expect(fetchMock).toHaveBeenCalledWith('http://custom.local:9000/agents', expect.anything());
    });

    it('does not silently drop a double slash when base URL has a trailing slash (documented, not normalized)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({ DEVDIGEST_API_URL: 'http://custom.local:9000/' });
      await adapter.listAgents();
      // Not normalized: base URL + path are concatenated verbatim, producing a double slash.
      expect(fetchMock).toHaveBeenCalledWith('http://custom.local:9000//agents', expect.anything());
    });
  });

  describe('auth header', () => {
    it('does not send Authorization when DEVDIGEST_API_TOKEN is unset', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({});
      await adapter.listAgents();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('does not send Authorization when DEVDIGEST_API_TOKEN is empty string', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({ DEVDIGEST_API_TOKEN: '' });
      await adapter.listAgents();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('sends Bearer token when DEVDIGEST_API_TOKEN is set', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({ DEVDIGEST_API_TOKEN: 'abc' });
      await adapter.listAgents();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer abc');
    });
  });

  describe('Content-Type header', () => {
    it('does not send Content-Type on GET requests', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({});
      await adapter.listAgents();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });

    it('sends Content-Type: application/json on POST with body', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ pr_id: 'pr1', runs: [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Agent' }], reviews: [] }),
      );
      const adapter = new HttpDevDigestAdapter({});
      await adapter.triggerReview('pull1', 'agent1');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });
  });

  describe('listAgents', () => {
    it('returns the array as-is on 200', async () => {
      const agents = [
        { id: 'a1', name: 'Agent One', description: 'desc1' },
        { id: 'a2', name: 'Agent Two', description: 'desc2' },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(agents));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.listAgents();
      expect(result).toEqual(agents);
    });
  });

  describe('findRepoByFullName', () => {
    it('returns the matching repo', async () => {
      const repos = [
        { id: 'r1', full_name: 'org/repo-one' },
        { id: 'r2', full_name: 'org/repo-two' },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(repos));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.findRepoByFullName('org/repo-two');
      expect(result).toEqual(repos[1]);
    });

    it('returns null when no repo matches (does not throw)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'r1', full_name: 'org/other' }]));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.findRepoByFullName('org/missing');
      expect(result).toBeNull();
    });
  });

  describe('findPullByNumber', () => {
    it('returns the matching pull', async () => {
      const pulls = [
        { id: 'p1', repo_id: 'r1', number: 1 },
        { id: 'p2', repo_id: 'r1', number: 2 },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(pulls));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.findPullByNumber('r1', 2);
      expect(result).toEqual(pulls[1]);
    });

    it('returns null when list is empty', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.findPullByNumber('r1', 99);
      expect(result).toBeNull();
    });
  });

  describe('triggerReview', () => {
    it('returns { runId } from runs[0].run_id on 200', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          pr_id: 'pr1',
          runs: [{ run_id: 'r1', agent_id: 'agent1', agent_name: 'Agent One' }],
          reviews: [],
        }),
      );
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.triggerReview('pull1', 'agent1');
      expect(result).toEqual({ runId: 'r1' });
    });

    it('throws AgentNotFoundError when 200 response has empty runs', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ pr_id: 'pr1', runs: [], reviews: [] }));
      const adapter = new HttpDevDigestAdapter({});
      await expect(adapter.triggerReview('pull1', 'agent1')).rejects.toThrow(AgentNotFoundError);
    });

    it('throws AgentNotFoundError on 404', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('not found', { status: 404, statusText: 'Not Found' }));
      const adapter = new HttpDevDigestAdapter({});
      await expect(adapter.triggerReview('pull1', 'bogus-agent')).rejects.toThrow(AgentNotFoundError);
    });

    it('throws AgentNotFoundError on 400 with "agent" mentioned in body', async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse('unknown agent id', { status: 400, statusText: 'Bad Request' }),
      );
      const adapter = new HttpDevDigestAdapter({});
      await expect(adapter.triggerReview('pull1', 'bogus-agent')).rejects.toThrow(AgentNotFoundError);
    });

    it('throws ApiUnreachableError with status embedded on 500', async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse('internal error', { status: 500, statusText: 'Internal Server Error' }),
      );
      const adapter = new HttpDevDigestAdapter({});
      try {
        await adapter.triggerReview('pull1', 'agent1');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiUnreachableError);
        expect((err as Error).message).toContain('500');
      }
    });
  });

  describe('listRunsForPull', () => {
    it('returns the RunSummary[] as-is', async () => {
      const runs = [{ run_id: 'r1', agent_id: 'a1', agent_name: 'Agent', status: 'running' }];
      fetchMock.mockResolvedValueOnce(jsonResponse(runs));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.listRunsForPull('pull1');
      expect(result).toEqual(runs);
    });
  });

  describe('listReviewsForPull', () => {
    it('returns the ReviewDto[] as-is', async () => {
      const reviews = [{ run_id: 'r1', verdict: 'approve', score: 1, created_at: '2026-01-01', findings: [] }];
      fetchMock.mockResolvedValueOnce(jsonResponse(reviews));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.listReviewsForPull('pull1');
      expect(result).toEqual(reviews);
    });
  });

  describe('listConventions', () => {
    it('returns candidates from the wrapped response', async () => {
      const candidates = [
        { id: 'c1', category: 'style', rule: 'use const', accepted: true, created_at: '2026-01-01' },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse({ candidates, scanned_at: '2026-01-01' }));
      const adapter = new HttpDevDigestAdapter({});
      const result = await adapter.listConventions('repo1');
      expect(result).toEqual(candidates);
    });
  });

  describe('error mapping', () => {
    it('throws ApiUnreachableError naming the URL when fetch rejects (network failure)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const adapter = new HttpDevDigestAdapter({});
      try {
        await adapter.listAgents();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiUnreachableError);
        expect((err as Error).message).toContain('http://localhost:3001/agents');
        expect((err as Error).message).toContain('ECONNREFUSED');
      }
    });

    it('throws ApiUnreachableError with status embedded on non-2xx GET (503)', async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse('service unavailable', { status: 503, statusText: 'Service Unavailable' }),
      );
      const adapter = new HttpDevDigestAdapter({});
      try {
        await adapter.listAgents();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiUnreachableError);
        expect((err as Error).message).toContain('503');
      }
    });
  });
});
