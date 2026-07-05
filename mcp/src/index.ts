#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContainer } from './platform/container.js';
import { registerTools } from './adapters/mcp-tools.js';

const container = createContainer(process.env);
const server = new McpServer({ name: 'devdigest', version: '0.1.0' });

registerTools(server, container, {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('[devdigest-mcp] connected over stdio\n');
