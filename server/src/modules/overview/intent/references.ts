import { createHash } from 'node:crypto';
import type { Container } from '../../../platform/container.js';
import type { CollectedReference } from './types.js';
import type { OctokitGitHubClient } from '../../../adapters/github/octokit.js';

const MAX_REFERENCES = 5;
const MAX_ISSUE_BODY_CHARS = 8_000;

/**
 * Best-effort collector for a single external-reference source. Never throws —
 * failures are mapped to `CollectedReference` rows with `status !== 'ok'`
 * (spec §8.2 "best-effort"; cross-cutting insight: one source's failure must
 * never fail the whole extraction job).
 */
type Collector = (
  container: Container,
  workspaceId: string,
  body: string,
  repoOwner: string,
  repoName: string,
  log: (msg: string) => void,
) => Promise<CollectedReference[]>;

function clip(body: string | null | undefined, maxChars: number): string {
  return (body ?? '').slice(0, maxChars);
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * P1 — GitHub linked issues. Uses `resolveLinkedIssues` (all matches) plus
 * `getIssue` per match to fetch full issue bodies, clipped to 8000 chars.
 *
 * `resolveLinkedIssues` is not (yet) part of the `ForgeClient` interface —
 * `BitbucketClient` has no GitHub-issue concept, so making it a required
 * interface method would force a meaningless implementation there. Per the
 * plan's Risk note, this collector narrows the `container.forgeClient('github')`
 * result to the concrete `OctokitGitHubClient` type at the call site instead of
 * widening the shared interface. If a future consumer needs this from a
 * `ForgeClient`-typed reference without knowing the concrete provider, promote
 * it to an optional interface method then.
 */
async function collectGithubIssues(
  container: Container,
  _workspaceId: string,
  body: string,
  repoOwner: string,
  repoName: string,
  log: (msg: string) => void,
): Promise<CollectedReference[]> {
  const repo = { owner: repoOwner, name: repoName };
  let client: OctokitGitHubClient;
  try {
    client = (await container.forgeClient('github')) as OctokitGitHubClient;
  } catch {
    // No GitHub credentials configured — best-effort, return nothing rather
    // than fail the whole job.
    return [];
  }

  const linked = client.resolveLinkedIssues(body, repo).slice(0, MAX_REFERENCES);
  if (linked.length === 0) return [];

  log(`Fetching ${linked.length} linked GitHub issue(s)`);

  const settled = await Promise.allSettled(
    linked.map((issue) => client.getIssue(repo, issue.number)),
  );

  return settled.map((result, i): CollectedReference => {
    const issue = linked[i]!;
    const fetchedAt = new Date().toISOString();
    if (result.status === 'rejected') {
      const err = result.reason as { status?: number } | undefined;
      const status = err?.status === 404 ? 'not_found' : 'unreachable';
      return {
        kind: 'github_issue',
        id: `#${issue.number}`,
        status,
        bodyHash: null,
        bodyChars: 0,
        fetchedAt,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        body: null,
      };
    }
    const clippedBody = clip(result.value.body, MAX_ISSUE_BODY_CHARS);
    return {
      kind: 'github_issue',
      id: `#${issue.number}`,
      status: 'ok',
      bodyHash: hashOf(clippedBody),
      bodyChars: clippedBody.length,
      fetchedAt,
      error: null,
      body: clippedBody,
    };
  });
}

/**
 * P2 — Jira/Linear tracker tickets. Stub in P1: always returns `[]`. Real
 * implementation (ticket-key detection + JiraClient/LinearClient) lands in the
 * P2 follow-up plan once P1 ships (spec §10.2).
 */
const collectTrackerTickets: Collector = async (
  _container,
  _workspaceId,
  _body,
  _repoOwner,
  _repoName,
  _log,
): Promise<CollectedReference[]> => {
  return [];
};

/**
 * P3 — allow-listed URL fetcher. Stub in P1: always returns `[]`. Real
 * implementation (SSRF-hardened `safeFetch` + host allow-list) lands in the P3
 * follow-up plan once P1/P2 ship (spec §10.3).
 */
const collectAllowlistedUrls: Collector = async (
  _container,
  _workspaceId,
  _body,
  _repoOwner,
  _repoName,
  _log,
): Promise<CollectedReference[]> => {
  return [];
};

function referenceKey(ref: CollectedReference): string {
  return `${ref.kind}:${ref.id}`;
}

function dedupe(refs: CollectedReference[]): CollectedReference[] {
  const seen = new Set<string>();
  const out: CollectedReference[] = [];
  for (const ref of refs) {
    const key = referenceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Orchestrates all reference collectors in parallel (spec §8.2/§10.4). Only
 * the GitHub-issue collector is real in P1; Jira/Linear/URL collectors are
 * stubs returning `[]` so P2/P3 call sites need no signature change. Combined
 * results are deduped by `(kind, id)` and hard-capped at 5 total.
 */
export async function collectReferences(
  container: Container,
  workspaceId: string,
  body: string,
  repoOwner: string,
  repoName: string,
  log: (msg: string) => void,
): Promise<CollectedReference[]> {
  const [issues, tickets, urls] = await Promise.all([
    collectGithubIssues(container, workspaceId, body, repoOwner, repoName, log), // P1
    collectTrackerTickets(container, workspaceId, body, repoOwner, repoName, log), // P2
    collectAllowlistedUrls(container, workspaceId, body, repoOwner, repoName, log), // P3
  ]);
  return dedupe([...issues, ...tickets, ...urls]).slice(0, MAX_REFERENCES);
}

// Exported for standalone unit tests of the P1 stub contract (T5 DoD).
export const _stubs = { collectTrackerTickets, collectAllowlistedUrls };
