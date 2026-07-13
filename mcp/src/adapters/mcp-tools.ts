/**
 * `registerTools` — the transport boundary between the MCP SDK and the pure
 * `services/*` layer.
 *
 * Rule A4 — Zod input schemas live ONLY in this file. Services receive
 * already-validated typed inputs (the SDK validates `inputSchema` before
 * invoking the handler).
 *
 * Rule A5 — this file never constructs `HttpDevDigestAdapter` directly; the
 * `Container` is passed in fully wired by `platform/container.ts`.
 *
 * Rule A6 — this file does not import `adapters/http-devdigest.ts`.
 *
 * Every handler is wrapped by `wrap()`, which centrally converts typed
 * errors (`BaseTypedError` subclasses from `platform/errors.ts`) into MCP
 * `isError: true` content. Non-typed (unexpected) errors are re-thrown so
 * the SDK's own machinery handles them — this file never constructs a raw
 * `Error` itself.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Container } from '../platform/container.js';
import { BaseTypedError } from '../platform/errors.js';
import { listAgents } from '../services/list-agents.js';
import { getConventions } from '../services/get-conventions.js';
import { getFindings } from '../services/get-findings.js';
import { runAgentOnPr } from '../services/run-agent-on-pr.js';
import { getBlastRadius } from '../services/get-blast-radius.js';

export interface McpToolDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

function successContent(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Central handler-wrapping helper (rule A2 analog for this file — never
 * constructs a raw `Error`). Typed errors become MCP error content; anything
 * else is re-thrown untouched.
 */
async function wrap<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    const result = await fn();
    return successContent(result);
  } catch (err) {
    if (err instanceof BaseTypedError) return err.toMcpErrorContent();
    throw err;
  }
}

export function registerTools(server: McpServer, container: Container, deps: McpToolDeps): void {
  server.registerTool(
    'list_agents',
    {
      description:
        'List configured reviewer agents. Use to discover valid agent ids before calling run_agent_on_pr.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => listAgents(container.devDigest)),
  );

  server.registerTool(
    'get_conventions',
    {
      description: 'Fetch repo conventions extracted by DevDigest for the given repo (owner/name).',
      inputSchema: {
        repo: z.string().min(1).describe('Repository as "owner/name" — e.g. "letyshops/dev-digest".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo }) => wrap(() => getConventions(container.devDigest, { repo })),
  );

  server.registerTool(
    'get_findings',
    {
      description:
        'Fetch the most recent review verdict and findings for a PR. Optionally filter by agent name.',
      inputSchema: {
        repo: z.string().min(1).describe('Repository as "owner/name".'),
        pr: z.number().int().positive().describe('GitHub PR number.'),
        agent: z.string().min(1).optional().describe('Optional reviewer agent name to filter results by.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, pr, agent }) => wrap(() => getFindings(container.devDigest, { repo, pr, agent })),
  );

  server.registerTool(
    'run_agent_on_pr',
    {
      description:
        'Trigger a reviewer agent on a PR, wait for the run to complete, return verdict + findings. Blocks up to 240s.',
      inputSchema: {
        repo: z.string().min(1).describe('Repository as "owner/name".'),
        pr: z.number().int().positive().describe('GitHub PR number.'),
        agent: z.string().min(1).describe('Agent id (from list_agents).'),
      },
    },
    async ({ repo, pr, agent }) => wrap(() => runAgentOnPr(container.devDigest, { repo, pr, agent }, deps)),
  );

  server.registerTool(
    'get_blast_radius',
    {
      description:
        'PR blast-radius map — not implemented yet (planned as course slice C). Returns an isError guidance message.',
      inputSchema: {
        repo: z.string().min(1).describe('Repository as "owner/name".'),
        pr: z.number().int().positive().describe('GitHub PR number.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, pr }) => wrap(() => getBlastRadius(container.devDigest, { repo, pr })),
  );
}
