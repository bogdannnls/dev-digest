# MCP Server — Development Plan

Date: 2026-07-05
Branch: l04
Status: awaiting user review
Revision: 2 (onion layout, T7 id-only, +T11 root docs)

## Design principles enforced (every tool task)

- **P-result** — tools return the final result, never an intermediate handle. `run_agent_on_pr` internally creates the run, polls to completion, fetches findings, and returns them in one call.
- **P-flat** — Zod input shapes are top-level scalars only (`{ repo: z.string(), pr: z.number(), agent: z.string() }`). Never nest params.
- **P-concise** — response bodies carry only what the caller needs. No `response_format` toggle.
- **P-forward-errors** — every error message names the next tool to call.

## Architecture (onion — inward-pointing dependencies)

```
mcp/src/
  index.ts                          — composition root
  platform/
    errors.ts                       — typed errors, each with toMcpErrorContent()
    container.ts                    — DI seam: createContainer() → { devDigest: DevDigestPort }
  domain/
    types.ts                        — Agent, Pull, Finding, Verdict, RunResult
    ports.ts                        — DevDigestPort interface
  services/                         — pure business logic; depends on port + typed errors only
    list-agents.ts
    run-agent-on-pr.ts
    get-findings.ts
    get-conventions.ts
    get-blast-radius.ts             — stub
  adapters/
    http-devdigest.ts               — implements DevDigestPort over fetch
    mcp-tools.ts                    — transport-adjacent: registers services as MCP tools with Zod schemas
```

Dependency direction:
- `adapters/*` → `domain/*` + `platform/errors`
- `services/*` → `domain/*` + `platform/errors`
- `platform/container.ts` → `adapters/*` + `domain/*`
- `index.ts` → `platform/container.ts` + `adapters/mcp-tools.ts`

Adapted onion rules (skill is scoped to `server/src/`; here we apply the spirit):
- **A1** — services never call `fetch` / any external client directly (analog of MUST.2). Only `adapters/http-devdigest.ts` does.
- **A2** — services never `throw new Error(...)`. Only typed errors from `platform/errors.ts` (analog of MUST.3).
- **A3** — services do not cross-import each other (analog of MUST.4). Shared logic lives in `domain/` or `platform/`.
- **A4** — Zod schemas live in `adapters/mcp-tools.ts` (the transport boundary — analog of MUST.6). Services receive already-validated typed inputs.
- **A5** — DI wiring lives only in `platform/container.ts` (analog of SHOULD.7).
- **A6** — `adapters/http-devdigest.ts` and `adapters/mcp-tools.ts` do not import each other (analog of MUST.5). Both compose via the container.

## Goal

Add a new top-level package `mcp/` that runs a local stdio MCP server (SDK v1.29.0) wrapping the existing Fastify API (`localhost:3001`, no auth). Exposes 5 tools — `list_agents`, `run_agent_on_pr`, `get_findings`, `get_conventions`, `get_blast_radius` (stub) — installable via `claude mcp add --scope project`.

## In scope

- New `mcp/` package with onion layout above.
- 5 tools with Zod input schemas, `readOnlyHint` annotations, response truncation, forward-guiding errors.
- `DEVDIGEST_API_URL` / `DEVDIGEST_API_TOKEN` env wiring (token inert today, forward-compatible).
- Unit tests: service tests use an in-memory `DevDigestPort` fake; HTTP adapter tested with mocked `fetch`; typed errors tested for message content.
- `claude mcp add --scope project` install docs in `mcp/README.md`.
- Root `README.md` packages table + root `CLAUDE.md` one-liner.

## Out of scope

- Real `get_blast_radius` implementation.
- Remote/HTTP MCP transport, multi-client support, multi-tenant auth.
- Any change to `server/` or `client/` code.
- CI wiring (`.github/workflows/*` do-not-touch zone).
- e2e browser flow coverage.
- **`agent` name-fallback** (locked: id-only).

## Verified route/shape facts (ground truth)

- `GET /agents` → `Agent[]` (workspace-scoped). `server/src/modules/agents/routes.ts:84`.
- `GET /repos` → `Repo[]` with `full_name` = `owner/name`.
- **No route resolves `owner/name → repoId` directly.** Adapter fetches `GET /repos`, filters by `full_name`.
- **No route resolves `(repoId, prNumber) → pullId` directly.** Adapter fetches `GET /repos/:id/pulls`, filters by `number`.
- **`POST /pulls/:id/review` is fire-and-forget.** Returns `{ pr_id, runs: [{run_id, agent_id, agent_name}], reviews: [] }` immediately; executes review in background. Body: `{ agentId? } | { all? }`. Polling mandatory.
- **No single `GET /runs/:id` status.** Poll `GET /pulls/:id/runs` (`RunSummary[]`, `status: 'running' | 'done' | 'failed' | 'cancelled' | null`), filter by `run_id`.
- Findings: `GET /pulls/:id/reviews` → `ReviewDto[]` with `verdict`, `score`, `findings: FindingRecord[]`.
- `GET /repos/:id/conventions?accepted?` → `{ candidates, scanned_at }`.
- **Real blast-radius route does not exist.** Stub is safe.
- Server has no auth (`LocalNoAuthProvider`).
- stdio: **all logging → `process.stderr`**. `console.log`/stdout corrupts the JSON-RPC channel.

## Cross-cutting insights

- `withIdleTimeout` under Anthropic rate-limit queuing: server idle timeout raised 60s→180s (commit `f63a509`). **MCP poll timeout budget: ≥240s.**
- SSE `done` emitted only after DB commit → polling `status !== 'running'` is race-free.
- Root `CLAUDE.md`: each package has own `package.json` + lockfile. No root-level lockfile.
- Root `CLAUDE.md`: secrets in `~/.devdigest/secrets.json` — MCP does **not** read this file.

## Task graph

```
T1 scaffold ── T2 domain+errors ──┬── T3 http-adapter+container ──┬── T4 list_agents
                                  │                               ├── T5 get_conventions
                                  │                               ├── T6 get_findings
                                  │                               ├── T7 run_agent_on_pr (uses T6 helpers)
                                  └── T8 blast_radius(stub) ──────┘
                                                                  └── T9 mcp-tools registration + bootstrap ── T10 mcp README ── T11 root docs
```

### T1 — Scaffold `mcp/` package

- **files**: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/src/index.ts` (empty bootstrap), `mcp/.gitignore`
- **depends_on**: none
- **what**: Skeleton mirroring `reviewer-core/`. Deps: `@modelcontextprotocol/sdk@1.29.0` (pin — not v2 beta), `zod`. Dev: `tsx`, `typescript`, `@types/node`, `vitest`. `src/index.ts` bootstraps a bare `McpServer` over `StdioServerTransport` with a trivial ping tool. **All logs → stderr.**
- **skills**: `typescript-expert`
- **test_command**: `cd mcp && pnpm build && pnpm typecheck`
- **done**: `pnpm install && pnpm build` succeeds. `npx @modelcontextprotocol/inspector node mcp/dist/index.js` connects. No `console.log`/stdout writes.

### T2 — Domain types + typed errors

- **files**:
  - `mcp/src/domain/types.ts` — `Agent`, `Repo`, `Pull`, `Finding`, `RunSummary`, `Verdict`, `RunResult`
  - `mcp/src/domain/ports.ts` — `DevDigestPort` interface (methods: `listAgents`, `findRepoByFullName`, `findPullByNumber`, `triggerReview`, `listRunsForPull`, `listReviewsForPull`, `listConventions`)
  - `mcp/src/platform/errors.ts` — `AgentNotFoundError`, `RepoNotFoundError`, `PullNotFoundError`, `RunTimeoutError`, `RunFailedError`, `ApiUnreachableError`, `NotImplementedError`. Base class exposes `toMcpErrorContent(): { isError: true; content: [{ type: 'text'; text: string }] }`; every subclass sets `nextTool: string` and the base template composes the forward-guiding message.
  - `mcp/src/platform/errors.test.ts`
- **depends_on**: T1
- **what**: All types and the typed-error hierarchy. Enforce **A2** — no `throw new Error` anywhere in `mcp/src/`. `toMcpErrorContent()` always contains the literal substring naming the next tool (e.g., `"agent not found — call list_agents ..."`).
- **skills**: `typescript-expert`, `zod`
- **test_command**: `cd mcp && pnpm exec vitest run src/platform/errors.test.ts`
- **done**: All 7 error classes have `toMcpErrorContent()` returning valid SDK error content shape with the correct forward-pointer. Types + port compile without any implementation stub.

### T3 — HTTP adapter + container

- **files**:
  - `mcp/src/adapters/http-devdigest.ts` — `class HttpDevDigestAdapter implements DevDigestPort`
  - `mcp/src/adapters/http-devdigest.test.ts`
  - `mcp/src/platform/container.ts` — `createContainer(env: NodeJS.ProcessEnv): { devDigest: DevDigestPort }`
- **depends_on**: T1, T2
- **what**: `HttpDevDigestAdapter` is the only place `fetch` is called (**A1**). Reads `env.DEVDIGEST_API_URL ?? 'http://localhost:3001'`. Attaches `Authorization: Bearer <token>` iff `env.DEVDIGEST_API_TOKEN` non-empty. Non-2xx / network failure → maps to the appropriate typed error from T2. `findRepoByFullName` and `findPullByNumber` do the client-side filter documented above. `container.ts` returns `{ devDigest: new HttpDevDigestAdapter(env) }` — only file allowed to construct adapters (**A5**).
- **skills**: `typescript-expert`, `security`
- **test_command**: `cd mcp && pnpm exec vitest run src/adapters/http-devdigest.test.ts`
- **done**: Adapter implements every `DevDigestPort` method; mocked fetch covers URL construction, auth header on/off, 404 → `RepoNotFoundError`/`PullNotFoundError` where applicable, network failure → `ApiUnreachableError`, non-2xx → typed error with actionable message. No `throw new Error` anywhere.

### T4 — Service: `listAgents`

- **files**: `mcp/src/services/list-agents.ts`, `mcp/src/services/list-agents.test.ts`
- **depends_on**: T2, T3
- **what**: `listAgents(port: DevDigestPort): Promise<{ agents: Array<{id, name, description}> }>`. Concise mapping — drops `provider`/`model`/`system_prompt` etc. On `ApiUnreachableError` the service lets it propagate (tool registration in T9 catches typed errors and converts to MCP error content). Sets the service pattern for T5–T8.
- **skills**: `typescript-expert`
- **test_command**: `cd mcp && pnpm exec vitest run src/services/list-agents.test.ts`
- **done**: Service uses an in-memory `DevDigestPort` fake (**not** a mocked fetch). Concise mapping asserted even when fake returns extra fields. Error propagation asserted for `ApiUnreachableError`.

### T5 — Service: `getConventions`

- **files**: `mcp/src/services/get-conventions.ts`, `mcp/src/services/get-conventions.test.ts`
- **depends_on**: T2, T3, T4
- **what**: `getConventions(port, { repo }): Promise<{ conventions: [...] }>`. Calls `port.findRepoByFullName(repo)` — null → `throw new RepoNotFoundError(repo)`. Then `port.listConventions(repoId)`. Concise mapping — rule text, category, accepted (final field list picked by implementer after reading `server/src/modules/conventions/service.ts`). Empty conventions is a valid state, not an error.
- **skills**: `typescript-expert`
- **test_command**: `cd mcp && pnpm exec vitest run src/services/get-conventions.test.ts`
- **done**: 3 cases: found + populated, found + empty (returns `{ conventions: [] }`), not found (throws `RepoNotFoundError`).

### T6 — Service: `getFindings`

- **files**: `mcp/src/services/get-findings.ts`, `mcp/src/services/get-findings.test.ts`
- **depends_on**: T2, T3, T4
- **what**: `getFindings(port, { repo, pr, agent? })`. Resolves repoId → pullId (both throw typed errors on miss). Fetches reviews via `port.listReviewsForPull(pullId)`. Picks most recent `ReviewDto` by `created_at` (optionally filtered by `agent_name === agent`). If `agent` filter matches none → `AgentNotFoundError` (forward to `list_agents`). Truncates `findings` to 25 with `truncated: true` when hit; the truncation message includes forward-guidance to narrow via `agent`. Returns `{ verdict, findings, truncated? }`.
- **skills**: `typescript-expert`, `response-schema`
- **test_command**: `cd mcp && pnpm exec vitest run src/services/get-findings.test.ts`
- **done**: 5 cases: no reviews yet (returns `{ verdict: null, findings: [] }`), multiple reviews no filter → most-recent picked, agent filter hit → returns that one, agent filter miss → `AgentNotFoundError`, findings > 25 → `truncated: true` with 25 items.

### T7 — Service: `runAgentOnPr` (id-only)

- **files**: `mcp/src/services/run-agent-on-pr.ts`, `mcp/src/services/run-agent-on-pr.test.ts`
- **depends_on**: T2, T3, T4, T6
- **what**: `runAgentOnPr(port, { repo, pr, agent }, deps: { now, sleep })`. Flow:
  1. Resolve repoId → pullId (typed errors on miss).
  2. `port.triggerReview(pullId, agent)` — passes `agent` **as agentId directly, no name fallback**. Server rejection or 404 → `AgentNotFoundError` (forward to `list_agents`).
  3. Poll `port.listRunsForPull(pullId)` every ~2s, find the row with matching `run_id`, wait for `status !== 'running'`. Hard timeout 240s → `RunTimeoutError` (forward to `get_findings` — the run may still complete server-side).
  4. On `status === 'failed'` → `RunFailedError` carrying the run's `error` field (surfaces as `verdict: 'error'`).
  5. On `status === 'done'` → fetch `port.listReviewsForPull(pullId)`, pick the review matching the `run_id`, apply truncation (25). Return `{ runId, verdict, findings, truncated? }`.
- **Verdict mapping** (server enum → tool 3-state; document in code comment):
  - `approve` + zero findings → `clean`
  - `approve` + non-zero findings OR `request_changes` OR `comment` → `issues`
  - `failed` / `cancelled` → `error`
- **id-only enforcement**: no `listAgents()` call for name resolution. Whatever string caller passes goes to `triggerReview` as agentId. Adapter maps server 404/error → `AgentNotFoundError`.
- **No cancellation**: if MCP process is killed mid-poll, server-side run continues and is recoverable via `get_findings`.
- **Injected `sleep` and `now`** for fake-timer tests.
- **skills**: `typescript-expert`, `response-schema`, `security`
- **insights**: `server/INSIGHTS.md` (2026-07-04 idle-timeout, 2026-06-24 SSE done-ordering)
- **test_command**: `cd mcp && pnpm exec vitest run src/services/run-agent-on-pr.test.ts`
- **done**: 5 cases with fake timers: happy path (poll reaches `done`, findings mapped, verdict `clean`|`issues`), failed run → `RunFailedError`, poll timeout → `RunTimeoutError`, invalid agent id → `AgentNotFoundError` from adapter, repo/PR miss → typed errors from resolvers.

### T8 — Service stub: `getBlastRadius`

- **files**: `mcp/src/services/get-blast-radius.ts`, `mcp/src/services/get-blast-radius.test.ts`
- **depends_on**: T2
- **what**: `getBlastRadius(_port, _input): never` — always throws `NotImplementedError` with message `"get_blast_radius is not implemented yet — planned as course slice C. Call list_agents or run_agent_on_pr in the meantime."`. Zero port calls.
- **skills**: `typescript-expert`
- **test_command**: `cd mcp && pnpm exec vitest run src/services/get-blast-radius.test.ts`
- **done**: Service throws `NotImplementedError` with exact message. Spy on port asserts zero calls. `NotImplementedError.toMcpErrorContent()` returns the isError shape T9 needs.

### T9 — MCP tools registration + bootstrap

- **files**: `mcp/src/adapters/mcp-tools.ts`, `mcp/src/adapters/mcp-tools.test.ts`, `mcp/src/index.ts` (updated)
- **depends_on**: T4, T5, T6, T7, T8
- **what**: `registerTools(server: McpServer, container: Container): void` — the only file that defines Zod schemas (**A4**). Each of the 5 tools:
  - Zod input schema (top-level scalars — P-flat).
  - `readOnlyHint: true` on `list_agents`, `get_findings`, `get_conventions`, `get_blast_radius`. **Omitted** on `run_agent_on_pr`.
  - Handler: `try { return { content: [{ type: 'text', text: JSON.stringify(result) }] } } catch (e) { if (e instanceof BaseTypedError) return e.toMcpErrorContent(); throw e; }`. Single central place converts typed errors → MCP error content.
- `index.ts`: `const container = createContainer(process.env); const server = new McpServer({ name: 'devdigest', version: '0.1.0' }); registerTools(server, container); await server.connect(new StdioServerTransport());`
- **skills**: `typescript-expert`, `zod`
- **test_command**: `cd mcp && pnpm exec vitest run src/adapters/mcp-tools.test.ts`
- **done**: All 5 tools registered with correct annotations (asserted via SDK's registration output). Handler test with a fake container asserts a thrown typed error surfaces as `isError: true` MCP content. `tools/list` via Inspector returns all 5 tools with the right hints (manual verification step).

### T10 — `mcp/README.md`

- **files**: `mcp/README.md`
- **depends_on**: T4–T9
- **what**: (1) package overview + tool list with one-line descriptions; (2) `pnpm install && pnpm build`; (3) exact install command:
  ```
  claude mcp add --scope project devdigest -- node <abs-path>/mcp/dist/index.js
  ```
  Note absolute path + that `--scope project` writes to `.claude/settings.json` (committed, not `settings.local.json`); (4) `DEVDIGEST_API_URL` (default `http://localhost:3001`) + `DEVDIGEST_API_TOKEN` (inert today, forward-compatible); (5) dev loop — `pnpm dev` + `npx @modelcontextprotocol/inspector node mcp/dist/index.js`; (6) explicit "not implemented" note for `get_blast_radius`.
- **skills**: `typescript-expert`
- **test_command**: (docs — read-through)
- **done**: A developer new to the package can install, register, and exercise all 5 tools via Inspector using only this README.

### T11 — Root docs update

- **files**: `README.md` (root), `CLAUDE.md` (root)
- **depends_on**: T10
- **what**:
  - `README.md`: extend the packages table with a row for `mcp/` — package name (`@devdigest/mcp` or similar, per repo convention), one-line "what it is", port column blank (stdio). Also brief mention in the architecture Mermaid if `mcp/` sits alongside `client/`/`server/`.
  - `CLAUDE.md`: add `mcp/` to the "Packages (4, no monorepo workspace)" section (bump to 5). One-line description matching other entries.
- **skills**: `typescript-expert`
- **test_command**: (docs — read-through)
- **done**: Both files reference `mcp/` consistently with the pattern used for `server/`/`client/`/`reviewer-core/`/`e2e/`.

## End-to-end verification

```bash
cd mcp && pnpm install && pnpm build && pnpm typecheck && pnpm test
npx @modelcontextprotocol/inspector node /Users/pandpbsa/Projects/dev-digest/mcp/dist/index.js
# → tools/list returns 5 tools; readOnlyHint true on all except run_agent_on_pr
claude mcp add --scope project devdigest -- node /Users/pandpbsa/Projects/dev-digest/mcp/dist/index.js
git diff .claude/settings.json  # → entry landed in the committed file, not settings.local.json
```

## Risks / open questions

- **Poll timeout 240s is a recommendation** — derived from idle-timeout insight, no locked SLA. Tunable post-merge.
- **SDK v1.29.0 API shape not verified** against installed code. T1 implementer must consult installed types (`server.registerTool` vs `server.tool`), not assume.
- **CI wiring not addressed** — `.github/workflows/*` do-not-touch. If MCP unit tests must run in CI, separate follow-up plan required.
- **`mcp/INSIGHTS.md` should be created via `/engineering-insights`** after implementation completes.
- **Onion adaptation is judgment**, not skill-enforced — the `onion-architecture` skill is scoped to `server/src/`. The `pr-self-review` workflow will not automatically check `mcp/` for onion violations. Reviewer must apply manually.
