/**
 * `HttpDevDigestAdapter` — the only file in `mcp/src/` allowed to call
 * `fetch` (rule A1). Implements `DevDigestPort` over the local Fastify API
 * (`server/`, no auth today).
 *
 * Error mapping is intentionally shallow here: network failures and non-2xx
 * responses become `ApiUnreachableError` (rule A2 — no raw `throw new
 * Error`). Domain-specific mapping (e.g. "repo not found" from a `null`
 * lookup) is the service layer's job — this adapter reports facts, it
 * doesn't decide what a miss means for the caller.
 */

import type { DevDigestPort } from '../domain/ports.js';
import type {
  Agent,
  ConventionCandidate,
  Pull,
  Repo,
  ReviewDto,
  RunSummary,
} from '../domain/types.js';
import { AgentNotFoundError, ApiUnreachableError } from '../platform/errors.js';

const DEFAULT_BASE_URL = 'http://localhost:3001';

interface TriggerReviewResponse {
  pr_id: string;
  runs: Array<{ run_id: string; agent_id: string; agent_name: string }>;
  reviews: unknown[];
}

interface ConventionsResponse {
  candidates: ConventionCandidate[];
  scanned_at: string | null;
}

export class HttpDevDigestAdapter implements DevDigestPort {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    const configuredUrl = env.DEVDIGEST_API_URL;
    this.baseUrl = configuredUrl && configuredUrl.length > 0 ? configuredUrl : DEFAULT_BASE_URL;
    const token = env.DEVDIGEST_API_TOKEN;
    this.token = token && token.length > 0 ? token : undefined;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ApiUnreachableError(url, cause);
    }

    if (!res.ok) {
      const bodyPreview = await this.readBodyPreview(res);
      throw new ApiUnreachableError(url, `${res.status} ${res.statusText}${bodyPreview ? ` — ${bodyPreview}` : ''}`);
    }

    return (await res.json()) as T;
  }

  private async readBodyPreview(res: Response): Promise<string> {
    try {
      const text = await res.text();
      return text.length > 300 ? `${text.slice(0, 300)}...` : text;
    } catch {
      return '';
    }
  }

  async listAgents(): Promise<Agent[]> {
    return this.request<Agent[]>('GET', '/agents');
  }

  async findRepoByFullName(fullName: string): Promise<Repo | null> {
    const repos = await this.request<Repo[]>('GET', '/repos');
    return repos.find((r) => r.full_name === fullName) ?? null;
  }

  async findPullByNumber(repoId: string, prNumber: number): Promise<Pull | null> {
    const pulls = await this.request<Pull[]>('GET', `/repos/${repoId}/pulls`);
    return pulls.find((p) => p.number === prNumber) ?? null;
  }

  async triggerReview(pullId: string, agentId: string): Promise<{ runId: string }> {
    const url = `${this.baseUrl}/pulls/${pullId}/review`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ agentId }),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ApiUnreachableError(url, cause);
    }

    if (!res.ok) {
      const bodyPreview = await this.readBodyPreview(res);
      if (res.status === 404 || (res.status === 400 && /agent/i.test(bodyPreview))) {
        throw new AgentNotFoundError(agentId);
      }
      throw new ApiUnreachableError(url, `${res.status} ${res.statusText}${bodyPreview ? ` — ${bodyPreview}` : ''}`);
    }

    const data = (await res.json()) as TriggerReviewResponse;
    const firstRun = data.runs[0];
    if (!firstRun) {
      throw new AgentNotFoundError(`${agentId} (server returned no run)`);
    }
    return { runId: firstRun.run_id };
  }

  async listRunsForPull(pullId: string): Promise<RunSummary[]> {
    return this.request<RunSummary[]>('GET', `/pulls/${pullId}/runs`);
  }

  async listReviewsForPull(pullId: string): Promise<ReviewDto[]> {
    return this.request<ReviewDto[]>('GET', `/pulls/${pullId}/reviews`);
  }

  async listConventions(repoId: string): Promise<ConventionCandidate[]> {
    const data = await this.request<ConventionsResponse>('GET', `/repos/${repoId}/conventions`);
    return data.candidates;
  }
}
