import { describe, expect, it } from 'vitest';
import {
  AgentNotFoundError,
  ApiUnreachableError,
  BaseTypedError,
  NotImplementedError,
  PullNotFoundError,
  RepoNotFoundError,
  RunFailedError,
  RunTimeoutError,
} from './errors.js';

/** Every valid MCP tool name a `toMcpErrorContent()` message may forward to. */
const VALID_TOOLS = [
  'list_agents',
  'run_agent_on_pr',
  'get_findings',
  'get_conventions',
  'get_blast_radius',
];

function assertForwardsToValidTool(text: string) {
  const matches = VALID_TOOLS.filter((tool) => text.includes(tool));
  expect(matches.length).toBeGreaterThan(0);
}

describe('BaseTypedError contract', () => {
  it('AgentNotFoundError is an instanceof BaseTypedError and Error', () => {
    const err = new AgentNotFoundError('x');
    expect(err instanceof BaseTypedError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('AgentNotFoundError', () => {
  it('toMcpErrorContent() names the agent and forwards to list_agents', () => {
    const err = new AgentNotFoundError('reviewer-42');
    const content = err.toMcpErrorContent();
    expect(content).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'agent `reviewer-42` not found — call `list_agents` to see available agents',
        },
      ],
    });
    assertForwardsToValidTool(content.content[0]!.text);
    expect(content.content[0]!.text).toContain('list_agents');
  });
});

describe('RepoNotFoundError', () => {
  it('toMcpErrorContent() names the repo and forwards to list_agents', () => {
    const err = new RepoNotFoundError('acme/widgets');
    const content = err.toMcpErrorContent();
    expect(content).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'repo `acme/widgets` not found — call `list_agents` and verify the repo was added to DevDigest (repo=owner/name)',
        },
      ],
    });
    assertForwardsToValidTool(content.content[0]!.text);
    expect(content.content[0]!.text).toContain('list_agents');
  });
});

describe('PullNotFoundError', () => {
  it('toMcpErrorContent() names the PR/repo and forwards to get_findings', () => {
    const err = new PullNotFoundError(42, 'acme/widgets');
    const content = err.toMcpErrorContent();
    expect(content).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'PR #42 not found in repo `acme/widgets` — call `get_findings` with a different pr number, or verify the PR exists in DevDigest',
        },
      ],
    });
    assertForwardsToValidTool(content.content[0]!.text);
    expect(content.content[0]!.text).toContain('get_findings');
  });
});

describe('RunTimeoutError', () => {
  it('toMcpErrorContent() names the run/timeout and forwards to get_findings', () => {
    const err = new RunTimeoutError('run-123', 240000);
    const content = err.toMcpErrorContent();
    expect(content).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'run `run-123` did not complete within 240000ms — call `get_findings` later — the run may still complete server-side',
        },
      ],
    });
    assertForwardsToValidTool(content.content[0]!.text);
    expect(content.content[0]!.text).toContain('get_findings');
  });
});

describe('RunFailedError', () => {
  it('toMcpErrorContent() names the run/server error and forwards to get_findings', () => {
    const err = new RunFailedError('run-123', 'LLM provider timeout');
    const content = err.toMcpErrorContent();
    expect(content).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'run `run-123` failed: LLM provider timeout — call `get_findings` to inspect any partial results, or run_agent_on_pr again',
        },
      ],
    });
    assertForwardsToValidTool(content.content[0]!.text);
    expect(content.content[0]!.text).toContain('get_findings');
  });
});

describe('ApiUnreachableError', () => {
  it('toMcpErrorContent() names the url/cause and forwards to list_agents', () => {
    const err = new ApiUnreachableError('http://localhost:3001', 'ECONNREFUSED');
    const content = err.toMcpErrorContent();
    expect(content).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'DevDigest API unreachable at http://localhost:3001: ECONNREFUSED — call `list_agents` once the DevDigest API is running at ${DEVDIGEST_API_URL}',
        },
      ],
    });
    assertForwardsToValidTool(content.content[0]!.text);
    expect(content.content[0]!.text).toContain('list_agents');
  });
});

describe('NotImplementedError', () => {
  it('toMcpErrorContent() returns the exact hard-coded literal', () => {
    const err = new NotImplementedError();
    const content = err.toMcpErrorContent();
    expect(content.isError).toBe(true);
    expect(content.content[0]!.text).toBe(
      'get_blast_radius is not implemented yet — planned as course slice C. Call list_agents or run_agent_on_pr in the meantime.',
    );
    assertForwardsToValidTool(content.content[0]!.text);
  });

  it('is an instanceof BaseTypedError and Error', () => {
    const err = new NotImplementedError();
    expect(err instanceof BaseTypedError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
