# @devdigest/mcp

Local Model Context Protocol (MCP) server that exposes 5 tools wrapping the DevDigest Fastify API. Runs as a child process spawned by Claude Code (or any MCP client) over stdio.

## Tools

| Name | What it does | Blocking? |
|---|---|---|
| `list_agents` | Lists configured reviewer agents (`id`, `name`, `description`). Source of valid agent ids for `run_agent_on_pr`. | No |
| `get_conventions` | Fetches the extracted conventions for a repo (`owner/name`). | No |
| `get_findings` | Concise verdict + findings from the most recent review of a PR. Optional `agent` name filter. Findings capped at 25 with a truncation hint. | No |
| `run_agent_on_pr` | Triggers a reviewer agent on a PR, polls until done, returns `{verdict, findings}`. `verdict` is `clean` / `issues` / `error`. Blocks up to 240s (the DevDigest server itself allows ~180s per run under Anthropic rate-limit queuing). | Yes |
| `get_blast_radius` | **Stub** — planned as course slice C. Always returns an `isError` message telling the caller to use `run_agent_on_pr` in the meantime. | No |

All tools accept flat scalar arguments (`repo: string`, `pr: number`, `agent: string`) — no nested objects. All error messages name the next MCP tool the caller should try (forward-guiding errors).

## Setup

```bash
cd mcp
pnpm install
pnpm build
```

Register with Claude Code (project scope — writes to `.claude/settings.json`, which is committed):

```bash
claude mcp add --scope project devdigest -- node /absolute/path/to/dev-digest/mcp/dist/index.js
```

The absolute path is required because `claude mcp add` records exactly what you pass. Verify:

```bash
git diff .claude/settings.json    # should show a new mcpServers entry
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DEVDIGEST_API_URL` | `http://localhost:3001` | Base URL of the DevDigest Fastify API. Override for non-default ports or remote testing. |
| `DEVDIGEST_API_TOKEN` | *(unset)* | Optional Bearer token. Inert today — the local server has no auth. Reserved so the MCP can pick up a real token once server-side auth lands. |

Set them either via the `env` block in your MCP client config or in the shell that launches the server.

The MCP does **not** read `~/.devdigest/secrets.json`. Secrets stay server-side.

## Dev loop

```bash
pnpm dev               # tsx watch on src/index.ts
```

In another terminal, launch the Inspector for interactive tool exploration:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

The Inspector opens at `http://localhost:6274` (or similar) and lets you call each tool with arbitrary arguments. `pnpm dev` streams stderr logs to the terminal (stdout is reserved for JSON-RPC — never printed to).

## Testing

```bash
pnpm test              # full vitest suite
pnpm exec vitest run src/services/get-findings.test.ts   # single file
pnpm typecheck
```

Services are tested with an in-memory `DevDigestPort` fake — no `fetch` mocking. The HTTP adapter (`src/adapters/http-devdigest.ts`) is tested with a mocked global `fetch`. `run_agent_on_pr` uses injected `{now, sleep}` deps + Vitest fake timers to deterministically drive the poll loop.

## Architecture

```
mcp/src/
  index.ts                          — composition root
  platform/
    errors.ts                       — typed errors (7 subclasses of BaseTypedError)
    container.ts                    — DI seam (createContainer)
  domain/
    types.ts                        — value types
    ports.ts                        — DevDigestPort interface
  services/                         — pure business logic (5 files)
  adapters/
    http-devdigest.ts               — DevDigestPort over fetch (only file calling fetch)
    mcp-tools.ts                    — registers services as MCP tools (only file with Zod schemas)
```

Onion, adapted from the `server/src/` skill: services never `fetch`, never `throw new Error`, and never cross-import each other. All I/O lives in `adapters/`. Zod input schemas live only in `adapters/mcp-tools.ts` (the transport seam).

Full design lives in [`docs/superpowers/specs/2026-07-05-mcp-server-plan.md`](../docs/superpowers/specs/2026-07-05-mcp-server-plan.md).

## Not implemented

`get_blast_radius` is a stub. The real implementation is planned as course slice C. Callers reaching it will receive:

```
get_blast_radius is not implemented yet — planned as course slice C.
Call list_agents or run_agent_on_pr in the meantime.
```
