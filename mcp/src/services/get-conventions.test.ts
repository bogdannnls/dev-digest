import { describe, expect, it, vi } from 'vitest';
import type { ConventionCandidate, DevDigestPort, Repo } from '../domain/ports.js';
import { ApiUnreachableError, RepoNotFoundError } from '../platform/errors.js';
import { getConventions } from './get-conventions.js';

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

const REPO: Repo = {
  id: 'repo-1',
  full_name: 'letyshops/dev-digest',
};

function makeCandidate(overrides: Partial<ConventionCandidate> = {}): ConventionCandidate {
  return {
    id: 'convention-1',
    category: 'style',
    rule: 'Use single quotes for strings',
    evidence_path: 'src/foo.ts',
    evidence_snippet: "const x = 'y';",
    evidence_start_line: 10,
    evidence_end_line: 10,
    confidence: 0.9,
    accepted: true,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getConventions', () => {
  it('returns concise conventions for a found repo with populated candidates', async () => {
    const candidates = [
      makeCandidate({ id: 'c1', rule: 'Use single quotes', category: 'style', accepted: true }),
      makeCandidate({ id: 'c2', rule: 'No default exports', category: 'imports', accepted: false }),
    ];
    const port = fakePort({
      findRepoByFullName: async (fullName) =>
        fullName === 'letyshops/dev-digest' ? REPO : null,
      listConventions: async () => candidates,
    });

    const result = await getConventions(port, { repo: 'letyshops/dev-digest' });

    expect(result).toEqual({
      conventions: [
        { rule: 'Use single quotes', category: 'style', accepted: true },
        { rule: 'No default exports', category: 'imports', accepted: false },
      ],
    });

    // Extra/internal fields must be absent from the concise mapping.
    for (const convention of result.conventions) {
      expect(convention).not.toHaveProperty('id');
      expect(convention).not.toHaveProperty('created_at');
      expect(convention).not.toHaveProperty('evidence_path');
      expect(convention).not.toHaveProperty('evidence_snippet');
      expect(convention).not.toHaveProperty('evidence_start_line');
      expect(convention).not.toHaveProperty('evidence_end_line');
      expect(convention).not.toHaveProperty('confidence');
    }
  });

  it('returns an empty conventions array when the repo has none yet (not an error)', async () => {
    const port = fakePort({
      findRepoByFullName: async () => REPO,
      listConventions: async () => [],
    });

    const result = await getConventions(port, { repo: 'letyshops/dev-digest' });

    expect(result).toEqual({ conventions: [] });
  });

  it('throws RepoNotFoundError when the repo is not found, without calling listConventions', async () => {
    const listConventions = vi.fn(async () => []);
    const port = fakePort({
      findRepoByFullName: async () => null,
      listConventions,
    });

    await expect(getConventions(port, { repo: 'ghost/repo' })).rejects.toThrow(
      RepoNotFoundError,
    );
    await expect(getConventions(port, { repo: 'ghost/repo' })).rejects.toThrow(
      /ghost\/repo/,
    );
    expect(listConventions).not.toHaveBeenCalled();
  });

  it('propagates ApiUnreachableError thrown by the port', async () => {
    const port = fakePort({
      findRepoByFullName: async () => REPO,
      listConventions: async () => {
        throw new ApiUnreachableError('http://localhost:3001', 'ECONNREFUSED');
      },
    });

    await expect(getConventions(port, { repo: 'letyshops/dev-digest' })).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
  });
});
