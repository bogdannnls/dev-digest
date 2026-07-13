import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { DevDigestPort, RunSummary } from '../domain/ports.js';
import { AgentNotFoundError } from '../platform/errors.js';
import type { Container } from '../platform/container.js';
import { registerTools } from './mcp-tools.js';

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

type ToolConfig = {
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
};
type ToolHandler = (args: unknown, extra?: unknown) => Promise<unknown>;

/**
 * Strategy B — spy on `McpServer#registerTool` to capture (name, config,
 * handler) triples, then invoke captured handlers directly. Cheaper than
 * spinning up a real client/transport pair for handler-level assertions.
 */
function captureRegistrations(server: McpServer): Map<string, { config: ToolConfig; handler: ToolHandler }> {
  const registrations = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  vi.spyOn(server, 'registerTool').mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((name: string, config: ToolConfig, handler: ToolHandler) => {
      registrations.set(name, { config, handler });
      return undefined as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
  return registrations;
}

function makeDeps() {
  return { now: () => 0, sleep: vi.fn(async () => {}) };
}

function extractText(result: { content: Array<{ type: 'text'; text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('registerTools', () => {
  it('registers exactly the 5 expected tools, no ping, no extras', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const registrations = captureRegistrations(server);
    const container: Container = { devDigest: fakePort() };

    registerTools(server, container, makeDeps());

    expect(new Set(registrations.keys())).toEqual(
      new Set(['list_agents', 'run_agent_on_pr', 'get_findings', 'get_conventions', 'get_blast_radius']),
    );
    expect(registrations.has('ping')).toBe(false);
  });

  it('sets readOnlyHint: true on the 4 read-only tools and omits it on run_agent_on_pr', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const registrations = captureRegistrations(server);
    const container: Container = { devDigest: fakePort() };

    registerTools(server, container, makeDeps());

    for (const name of ['list_agents', 'get_findings', 'get_conventions', 'get_blast_radius']) {
      expect(registrations.get(name)?.config.annotations?.readOnlyHint).toBe(true);
    }
    expect(registrations.get('run_agent_on_pr')?.config.annotations?.readOnlyHint).toBeFalsy();
  });

  it('list_agents happy path returns JSON content with no isError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const registrations = captureRegistrations(server);
    const container: Container = {
      devDigest: fakePort({
        listAgents: async () => [{ id: 'a1', name: 'General', description: 'x' }],
      }),
    };

    registerTools(server, container, makeDeps());

    const result = (await registrations.get('list_agents')!.handler({})) as {
      content: Array<{ type: 'text'; text: string }>;
      isError?: true;
    };

    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toEqual({
      agents: [{ id: 'a1', name: 'General', description: 'x' }],
    });
  });

  it('converts a typed error thrown by run_agent_on_pr into isError MCP content with forward-guidance', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const registrations = captureRegistrations(server);
    const container: Container = {
      devDigest: fakePort({
        findRepoByFullName: async () => ({ id: 'repo-1', full_name: 'acme/widgets' }),
        findPullByNumber: async () => ({ id: 'pull-1', repo_id: 'repo-1', number: 42 }),
        triggerReview: async () => {
          throw new AgentNotFoundError('bogus');
        },
      }),
    };

    registerTools(server, container, makeDeps());

    const result = (await registrations.get('run_agent_on_pr')!.handler({
      repo: 'acme/widgets',
      pr: 42,
      agent: 'bogus',
    })) as { content: Array<{ type: 'text'; text: string }>; isError?: true };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('list_agents');
  });

  it('get_blast_radius stub returns isError with the exact literal message', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const registrations = captureRegistrations(server);
    const container: Container = { devDigest: fakePort() };

    registerTools(server, container, makeDeps());

    const result = (await registrations.get('get_blast_radius')!.handler({
      repo: 'acme/widgets',
      pr: 42,
    })) as { content: Array<{ type: 'text'; text: string }>; isError?: true };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('get_blast_radius is not implemented yet');
  });

  it('propagates injected deps to run_agent_on_pr — fast path never calls sleep', async () => {
    const sleep = vi.fn(async () => {});
    const doneRun: RunSummary = {
      run_id: 'run-1',
      agent_id: 'a1',
      agent_name: 'General',
      status: 'done',
    };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const registrations = captureRegistrations(server);
    const container: Container = {
      devDigest: fakePort({
        findRepoByFullName: async () => ({ id: 'repo-1', full_name: 'acme/widgets' }),
        findPullByNumber: async () => ({ id: 'pull-1', repo_id: 'repo-1', number: 42 }),
        triggerReview: async () => ({ runId: 'run-1' }),
        listRunsForPull: async () => [doneRun],
        listReviewsForPull: async () => [
          {
            run_id: 'run-1',
            agent_name: 'General',
            verdict: 'approve',
            score: 100,
            created_at: '2026-01-01T00:00:00.000Z',
            findings: [],
          },
        ],
      }),
    };

    registerTools(server, container, { now: () => 42, sleep });

    const result = (await registrations.get('run_agent_on_pr')!.handler({
      repo: 'acme/widgets',
      pr: 42,
      agent: 'a1',
    })) as { content: Array<{ type: 'text'; text: string }>; isError?: true };

    expect(result.isError).toBeUndefined();
    expect(extractText(result)).toMatchObject({ runId: 'run-1', verdict: 'clean' });
    expect(sleep).not.toHaveBeenCalled();
  });
});
