import { describe, expect, it } from 'vitest';
import type { Agent, DevDigestPort } from '../domain/ports.js';
import { ApiUnreachableError } from '../platform/errors.js';
import { listAgents } from './list-agents.js';

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

describe('listAgents', () => {
  it('returns a concise {id, name, description} mapping, dropping extra fields', async () => {
    const port = fakePort({
      listAgents: async () =>
        [
          {
            id: 'agent-1',
            name: 'Security Reviewer',
            description: 'Flags security issues',
            provider: 'anthropic',
            model: 'claude-opus-4',
            system_prompt: 'You are a security expert...',
          },
          {
            id: 'agent-2',
            name: 'Style Reviewer',
            description: 'Flags style issues',
            provider: 'openai',
            model: 'gpt-5',
            system_prompt: 'You are a style expert...',
          },
        ] as Agent[],
    });

    const result = await listAgents(port);

    expect(result).toEqual({
      agents: [
        { id: 'agent-1', name: 'Security Reviewer', description: 'Flags security issues' },
        { id: 'agent-2', name: 'Style Reviewer', description: 'Flags style issues' },
      ],
    });
    for (const agent of result.agents) {
      expect(Object.keys(agent).sort()).toEqual(['description', 'id', 'name']);
    }
  });

  it('returns an empty agents array when the port has none', async () => {
    const port = fakePort({ listAgents: async () => [] });

    const result = await listAgents(port);

    expect(result).toEqual({ agents: [] });
  });

  it('defaults a missing/undefined description to an empty string', async () => {
    const port = fakePort({
      listAgents: async () =>
        [
          {
            id: 'agent-1',
            name: 'No Description Agent',
            description: undefined,
          },
        ] as unknown as Agent[],
    });

    const result = await listAgents(port);

    expect(result).toEqual({
      agents: [{ id: 'agent-1', name: 'No Description Agent', description: '' }],
    });
  });

  it('propagates ApiUnreachableError from the port unchanged', async () => {
    const error = new ApiUnreachableError('http://localhost:3001', 'ECONNREFUSED');
    const port = fakePort({
      listAgents: async () => {
        throw error;
      },
    });

    await expect(listAgents(port)).rejects.toBe(error);
    await expect(listAgents(port)).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
