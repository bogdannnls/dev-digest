/**
 * `listAgents` — service backing the `list_agents` tool.
 *
 * Concise mapping (rule P-concise): the port's `Agent` type carries fields
 * (`provider`, `model`, `system_prompt`, ...) that callers of `list_agents`
 * never need. This service narrows every entry down to `{id, name,
 * description}` before it reaches the transport boundary.
 *
 * Errors (e.g. `ApiUnreachableError` from `port.listAgents()`) are not
 * caught here — they propagate to the tool handler registered in T9, which
 * centrally converts typed errors into MCP error content (rule A2 — this
 * file never does `throw new Error(...)`).
 */

import type { DevDigestPort } from '../domain/ports.js';

export interface ListAgentsResult {
  agents: Array<{ id: string; name: string; description: string }>;
}

export async function listAgents(port: DevDigestPort): Promise<ListAgentsResult> {
  const agents = await port.listAgents();
  return {
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? '',
    })),
  };
}
