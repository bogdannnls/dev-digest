import { describe, it, expect, vi } from 'vitest';
import { collectReferences, _stubs } from './references.js';
import type { Container } from '../../../platform/container.js';

function makeContainer(opts: {
  resolveLinkedIssues?: (body: string, repo: unknown) => Array<{ number: number; url: string }>;
  getIssue?: (repo: unknown, n: number) => Promise<{ number: number; title: string; body: string | null; state: string }>;
  forgeClientThrows?: boolean;
}): Partial<Container> {
  return {
    forgeClient: vi.fn().mockImplementation(async () => {
      if (opts.forgeClientThrows) throw new Error('GITHUB_TOKEN is not configured');
      return {
        resolveLinkedIssues: opts.resolveLinkedIssues ?? (() => []),
        getIssue: opts.getIssue ?? (async (_repo: unknown, n: number) => ({
          number: n,
          title: `Issue ${n}`,
          body: `Body of issue ${n}`,
          state: 'open',
        })),
      };
    }),
  };
}

const REPO_OWNER = 'acme';
const REPO_NAME = 'widgets';
const noopLog = () => {};

describe('collectReferences', () => {
  it('returns an ok row for a resolved issue and an unreachable row for a failed fetch', async () => {
    const container = makeContainer({
      resolveLinkedIssues: () => [
        { number: 12, url: 'https://github.com/acme/widgets/issues/12' },
        { number: 34, url: 'https://github.com/acme/widgets/issues/34' },
      ],
      getIssue: async (_repo, n) => {
        if (n === 34) throw new Error('boom');
        return { number: n, title: 'Issue 12', body: 'Full body of #12', state: 'open' };
      },
    });

    const refs = await collectReferences(
      container as unknown as Container,
      'ws-1',
      'Closes #12, see also #34',
      REPO_OWNER,
      REPO_NAME,
      noopLog,
    );

    expect(refs).toHaveLength(2);
    const ok = refs.find((r) => r.id === '#12');
    const failed = refs.find((r) => r.id === '#34');
    expect(ok).toMatchObject({ kind: 'github_issue', status: 'ok' });
    expect(ok!.bodyChars).toBeGreaterThan(0);
    expect(ok!.bodyHash).toEqual(expect.any(String));
    expect(failed).toMatchObject({ kind: 'github_issue', status: 'unreachable' });
    expect(failed!.bodyChars).toBe(0);
    expect(failed!.bodyHash).toBeNull();
  });

  it('never throws when forgeClient itself rejects (no credentials configured)', async () => {
    const container = makeContainer({ forgeClientThrows: true });
    const refs = await collectReferences(
      container as unknown as Container,
      'ws-1',
      'Closes #12',
      REPO_OWNER,
      REPO_NAME,
      noopLog,
    );
    expect(refs).toEqual([]);
  });

  it('caps the result at 5 entries even if the body links more than 5 issues', async () => {
    const numbers = [1, 2, 3, 4, 5, 6, 7];
    const container = makeContainer({
      resolveLinkedIssues: () =>
        numbers.map((n) => ({ number: n, url: `https://github.com/acme/widgets/issues/${n}` })),
    });

    const body = numbers.map((n) => `closes #${n}`).join(', ');
    const refs = await collectReferences(
      container as unknown as Container,
      'ws-1',
      body,
      REPO_OWNER,
      REPO_NAME,
      noopLog,
    );

    expect(refs).toHaveLength(5);
  });

  it('dedupes the same issue referenced twice (bare #12 and closes #12)', async () => {
    const container = makeContainer({
      resolveLinkedIssues: (body) => {
        // Mirror OctokitGitHubClient's own dedupe contract: one entry per
        // distinct issue regardless of how many times it's mentioned.
        const seen = new Set<number>();
        const out: Array<{ number: number; url: string }> = [];
        for (const m of body.matchAll(/#(\d+)/g)) {
          const n = Number(m[1]);
          if (seen.has(n)) continue;
          seen.add(n);
          out.push({ number: n, url: `https://github.com/acme/widgets/issues/${n}` });
        }
        return out;
      },
    });

    const refs = await collectReferences(
      container as unknown as Container,
      'ws-1',
      'closes #12, also mentioned again as #12',
      REPO_OWNER,
      REPO_NAME,
      noopLog,
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe('#12');
  });

  it('returns [] when there are no linked issues', async () => {
    const container = makeContainer({ resolveLinkedIssues: () => [] });
    const refs = await collectReferences(
      container as unknown as Container,
      'ws-1',
      'no issues mentioned here',
      REPO_OWNER,
      REPO_NAME,
      noopLog,
    );
    expect(refs).toEqual([]);
  });
});

describe('P1 stub collectors (P2/P3 contract)', () => {
  it('collectTrackerTickets always returns [] in P1', async () => {
    const container = makeContainer({});
    await expect(
      _stubs.collectTrackerTickets(
        container as unknown as Container,
        'ws-1',
        'PROJ-123 fixes this',
        REPO_OWNER,
        REPO_NAME,
        noopLog,
      ),
    ).resolves.toEqual([]);
  });

  it('collectAllowlistedUrls always returns [] in P1', async () => {
    const container = makeContainer({});
    await expect(
      _stubs.collectAllowlistedUrls(
        container as unknown as Container,
        'ws-1',
        'see https://example.com/doc',
        REPO_OWNER,
        REPO_NAME,
        noopLog,
      ),
    ).resolves.toEqual([]);
  });
});
