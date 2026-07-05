#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'devdigest',
  version: '0.1.0',
});

server.registerTool(
  'ping',
  {
    description:
      'Placeholder tool exercised during scaffolding. Replaced by the 5 real tools (list_agents, run_agent_on_pr, get_findings, get_conventions, get_blast_radius) in T9.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('[devdigest-mcp] connected over stdio\n');
