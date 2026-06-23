import type {
  ForgeClient,
  RepoRef,
  PrMeta,
  PrDetail,
  ForgeReviewPayload,
  PrReviewComment,
  CreateReviewCommentInput,
  OpenPrPayload,
  CommitFilesPayload,
  IssueMeta,
} from '@devdigest/shared';
import { emptyFindingsBuckets } from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';
import { withRetry, withTimeout } from '../../platform/resilience.js';

const TIMEOUT = 30_000;
const BASE = 'https://api.bitbucket.org/2.0';

type PrStatus = 'open' | 'merged' | 'closed';

function mapState(state: string): PrStatus {
  if (state === 'MERGED') return 'merged';
  if (state === 'OPEN') return 'open';
  return 'closed'; // DECLINED, SUPERSEDED
}

interface BitbucketAuth {
  token?: string;
  username?: string;
  appPassword?: string;
}

export class BitbucketClient implements ForgeClient {
  private authHeader: string;

  constructor(auth: BitbucketAuth) {
    if (auth.token) {
      this.authHeader = `Bearer ${auth.token}`;
    } else if (auth.username && auth.appPassword) {
      this.authHeader = `Basic ${Buffer.from(`${auth.username}:${auth.appPassword}`).toString('base64')}`;
    } else {
      throw new AppError('config_error', 'BitbucketClient requires either token or username+appPassword', 500);
    }
  }

  private async call<T>(urlOrPath: string, opts: RequestInit = {}): Promise<T> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${BASE}${urlOrPath}`;
    const isForm = opts.body instanceof FormData;
    const res = await withRetry(() =>
      withTimeout(
        fetch(url, {
          ...opts,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            ...(opts.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
            ...(opts.headers as Record<string, string> | undefined),
          },
        }),
        TIMEOUT,
      ),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = (() => {
        try {
          return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
        } catch {
          return text;
        }
      })();
      if (res.status === 401) throw new AppError('unauthorized', msg || 'Unauthorized', 401);
      if (res.status === 403) throw new AppError('forbidden', msg || 'Forbidden', 403);
      if (res.status === 404) throw new AppError('not_found', msg || 'Not found', 404);
      throw new AppError('api_error', msg || 'Bitbucket API error', res.status);
    }
    return res.json() as Promise<T>;
  }

  private async paginate<T>(path: string, limit: number): Promise<T[]> {
    const results: T[] = [];
    let next: string | null = `${BASE}${path}`;
    while (next && results.length < limit) {
      type Page = { values: T[]; next?: string };
      const page: Page = await this.call<Page>(next);
      results.push(...page.values);
      next = page.next ?? null;
    }
    return results;
  }

  async listPullRequests(repo: RepoRef): Promise<PrMeta[]> {
    const prs = await this.paginate<{
      id: number;
      title: string;
      author: { nickname?: string; display_name?: string };
      source: { branch: { name: string }; commit: { hash: string } };
      destination: { branch: { name: string } };
      state: string;
      created_on: string;
      updated_on: string;
    }>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests?state=ALL&sort=-updated_on&pagelen=50`,
      50,
    );
    return prs.map((pr) => ({
      number: pr.id,
      title: pr.title,
      author: pr.author.nickname ?? pr.author.display_name ?? 'unknown',
      branch: pr.source.branch.name,
      base: pr.destination.branch.name,
      head_sha: pr.source.commit.hash,
      additions: 0,
      deletions: 0,
      files_count: 0,
      status: mapState(pr.state),
      opened_at: pr.created_on,
      updated_at: pr.updated_on,
      findings: emptyFindingsBuckets(),
    }));
  }

  async getPullRequest(repo: RepoRef, n: number): Promise<PrDetail> {
    const [pr, diffstat, rawDiff, commitsPage] = await Promise.all([
      this.call<{
        id: number;
        title: string;
        author: { nickname?: string; display_name?: string };
        source: { branch: { name: string }; commit: { hash: string } };
        destination: { branch: { name: string } };
        state: string;
        created_on: string;
        updated_on: string;
        description?: string;
      }>(`/repositories/${repo.owner}/${repo.name}/pullrequests/${n}`),
      this.call<{
        values: Array<{
          new?: { path: string };
          old?: { path: string };
          lines_added: number;
          lines_removed: number;
        }>;
      }>(`/repositories/${repo.owner}/${repo.name}/pullrequests/${n}/diffstat`),
      this.call<string>(`/repositories/${repo.owner}/${repo.name}/pullrequests/${n}/diff`).catch(() => ''),
      this.paginate<{
        hash: string;
        message: string;
        date: string;
        author: { user?: { nickname?: string; display_name?: string }; raw?: string };
      }>(`/repositories/${repo.owner}/${repo.name}/pullrequests/${n}/commits?pagelen=100`, 100),
    ]);

    const patchByPath = parseDiff(typeof rawDiff === 'string' ? rawDiff : '');
    const files = diffstat.values.map((f) => {
      const path = f.new?.path ?? f.old?.path ?? '';
      return {
        path,
        additions: f.lines_added,
        deletions: f.lines_removed,
        patch: patchByPath.get(path) ?? null,
      };
    });

    const additions = files.reduce((s, f) => s + f.additions, 0);
    const deletions = files.reduce((s, f) => s + f.deletions, 0);

    const linked_issue = await this.resolveLinkedIssue(repo, pr.description ?? '');

    return {
      number: pr.id,
      title: pr.title,
      author: pr.author.nickname ?? pr.author.display_name ?? 'unknown',
      branch: pr.source.branch.name,
      base: pr.destination.branch.name,
      head_sha: pr.source.commit.hash,
      additions,
      deletions,
      files_count: files.length,
      status: mapState(pr.state),
      opened_at: pr.created_on,
      updated_at: pr.updated_on,
      body: pr.description ?? null,
      files,
      commits: commitsPage.map((c) => ({
        sha: c.hash,
        message: c.message,
        author: c.author.user?.nickname ?? c.author.user?.display_name ?? c.author.raw ?? 'unknown',
        committed_at: c.date,
      })),
      linked_issue,
      findings: emptyFindingsBuckets(),
    };
  }

  private async resolveLinkedIssue(repo: RepoRef, body: string): Promise<IssueMeta | undefined> {
    const m = body.match(/(?:closes|fixes|resolves)?\s*#(\d+)/i);
    if (!m?.[1]) return undefined;
    try {
      return await this.getIssue(repo, Number(m[1]));
    } catch {
      return undefined;
    }
  }

  async postReview(repo: RepoRef, n: number, review: ForgeReviewPayload): Promise<{ id: string }> {
    const base = `/repositories/${repo.owner}/${repo.name}/pullrequests/${n}`;
    if (review.event === 'APPROVE') {
      await this.call(`${base}/approve`, { method: 'POST', body: JSON.stringify({}) });
    } else if (review.event === 'REQUEST_CHANGES') {
      await this.call(`${base}/request-changes`, { method: 'POST', body: JSON.stringify({}) });
    }
    // For inline comments, post each individually
    const ids: number[] = [];
    for (const c of review.comments ?? []) {
      const res = await this.call<{ id: number }>(`${base}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          content: { raw: c.body },
          inline: { path: c.path, to: c.line },
        }),
      });
      ids.push(res.id);
    }
    return { id: String(ids[0] ?? `bb-${n}-${review.event}`) };
  }

  async listReviewComments(repo: RepoRef, n: number): Promise<PrReviewComment[]> {
    const comments = await this.paginate<{
      id: number;
      content: { raw: string };
      created_on: string;
      author: { nickname?: string; display_name?: string };
      inline?: { path: string; to?: number; from?: number };
      parent?: { id: number };
      links: { html: { href: string } };
    }>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests/${n}/comments?pagelen=100`,
      100,
    );
    return comments
      .filter((c) => c.inline !== undefined)
      .map((c) => ({
        id: c.id,
        path: c.inline!.path,
        line: c.inline!.to ?? null,
        original_line: c.inline!.from ?? null,
        side: 'RIGHT' as const,
        body: c.content.raw,
        user: c.author.nickname ?? c.author.display_name ?? 'unknown',
        created_at: c.created_on,
        html_url: c.links.html.href,
        in_reply_to_id: c.parent?.id ?? null,
        is_outdated: c.inline!.to == null,
      }));
  }

  async createReviewComment(repo: RepoRef, n: number, input: CreateReviewCommentInput): Promise<PrReviewComment> {
    const body =
      input.inReplyTo != null
        ? { content: { raw: input.body }, parent: { id: input.inReplyTo } }
        : { content: { raw: input.body }, inline: { path: input.path, to: input.line } };

    const res = await this.call<{
      id: number;
      content: { raw: string };
      created_on: string;
      author: { nickname?: string; display_name?: string };
      inline?: { path: string; to?: number; from?: number };
      parent?: { id: number };
      links: { html: { href: string } };
    }>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests/${n}/comments`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return {
      id: res.id,
      path: res.inline?.path ?? input.path,
      line: res.inline?.to ?? null,
      original_line: res.inline?.from ?? null,
      side: 'RIGHT',
      body: res.content.raw,
      user: res.author.nickname ?? res.author.display_name ?? 'unknown',
      created_at: res.created_on,
      html_url: res.links.html.href,
      in_reply_to_id: res.parent?.id ?? null,
      is_outdated: false,
    };
  }

  async openPullRequest(repo: RepoRef, payload: OpenPrPayload): Promise<{ url: string }> {
    const res = await this.call<{ links: { html: { href: string } } }>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: payload.title,
          source: { branch: { name: payload.head } },
          destination: { branch: { name: payload.base } },
          description: payload.body,
        }),
      },
    );
    return { url: res.links.html.href };
  }

  async commitFiles(repo: RepoRef, payload: CommitFilesPayload): Promise<{ branch: string }> {
    // Determine whether the branch exists; if not, get base HEAD SHA for /parents.
    let parentSha: string | undefined;
    try {
      await this.call(`/repositories/${repo.owner}/${repo.name}/refs/branches/${encodeURIComponent(payload.branch)}`);
      // Branch exists — no /parents needed (Bitbucket fast-forwards it)
    } catch (err) {
      if (!(err instanceof AppError && err.statusCode === 404)) throw err;
      const base = await this.call<{ target: { hash: string } }>(
        `/repositories/${repo.owner}/${repo.name}/refs/branches/${encodeURIComponent(payload.base)}`,
      );
      parentSha = base.target.hash;
    }

    const srcUrl = `${BASE}/repositories/${repo.owner}/${repo.name}/src`;
    await withRetry(async () => {
      const form = new FormData();
      form.set('/branch', payload.branch);
      form.set('/message', payload.message);
      if (parentSha) form.set('/parents', parentSha);
      for (const file of payload.files) {
        form.set(file.path, file.contents);
      }
      const res = await withTimeout(
        fetch(srcUrl, { method: 'POST', headers: { Authorization: this.authHeader }, body: form }),
        TIMEOUT,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AppError('api_error', text || 'Bitbucket commit failed', res.status);
      }
    });

    return { branch: payload.branch };
  }

  async findOpenPr(repo: RepoRef, branch: string): Promise<{ url: string } | null> {
    const result = await this.call<{ values: Array<{ links: { html: { href: string } } }> }>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests?q=source.branch.name="${encodeURIComponent(branch)}"+AND+state="OPEN"&pagelen=1`,
    );
    const pr = result.values[0];
    return pr ? { url: pr.links.html.href } : null;
  }

  async getIssue(repo: RepoRef, n: number): Promise<IssueMeta> {
    const issue = await this.call<{
      id: number;
      title: string;
      content?: { raw?: string };
      state: string;
    }>(`/repositories/${repo.owner}/${repo.name}/issues/${n}`);
    return {
      number: issue.id,
      title: issue.title,
      body: issue.content?.raw ?? null,
      state: issue.state,
    };
  }

  async currentLogin(): Promise<string> {
    const user = await this.call<{ nickname?: string; display_name?: string }>('/user');
    return user.nickname ?? user.display_name ?? 'unknown';
  }
}

function parseDiff(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = raw.split(/^diff --git /m).filter(Boolean);
  for (const section of sections) {
    const match = section.match(/^a\/.+? b\/(.+?)\n/);
    if (match?.[1]) {
      result.set(match[1], `diff --git ${section}`);
    }
  }
  return result;
}
