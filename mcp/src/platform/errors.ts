/**
 * Typed error hierarchy for the MCP server.
 *
 * Rule A2 — no `throw new Error(...)` anywhere in `mcp/src/`. Every thrown
 * error must be one of these typed subclasses.
 *
 * Rule P-forward-errors — every error message names the next tool to call.
 * `BaseTypedError.toMcpErrorContent()` composes that forward-guiding text
 * from each subclass's `nextTool`/`hint`, so the invariant holds by
 * construction rather than by convention.
 */

export type McpErrorContent = {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
};

export abstract class BaseTypedError extends Error {
  abstract readonly nextTool: string;
  abstract readonly hint: string;

  toMcpErrorContent(): McpErrorContent {
    return {
      isError: true,
      content: [{ type: 'text', text: `${this.message} — call \`${this.nextTool}\` ${this.hint}` }],
    };
  }
}

export class AgentNotFoundError extends BaseTypedError {
  readonly nextTool = 'list_agents';
  readonly hint = 'to see available agents';

  constructor(public readonly agentId: string) {
    super(`agent \`${agentId}\` not found`);
    this.name = 'AgentNotFoundError';
  }
}

export class RepoNotFoundError extends BaseTypedError {
  readonly nextTool = 'list_agents';
  readonly hint =
    'and verify the repo was added to DevDigest (repo=owner/name)';

  constructor(public readonly fullName: string) {
    super(`repo \`${fullName}\` not found`);
    this.name = 'RepoNotFoundError';
  }
}

export class PullNotFoundError extends BaseTypedError {
  readonly nextTool = 'get_findings';
  readonly hint = 'with a different pr number, or verify the PR exists in DevDigest';

  constructor(
    public readonly prNumber: number,
    public readonly repoFullName: string,
  ) {
    super(`PR #${prNumber} not found in repo \`${repoFullName}\``);
    this.name = 'PullNotFoundError';
  }
}

export class RunTimeoutError extends BaseTypedError {
  readonly nextTool = 'get_findings';
  readonly hint = 'later — the run may still complete server-side';

  constructor(
    public readonly runId: string,
    public readonly timeoutMs: number,
  ) {
    super(`run \`${runId}\` did not complete within ${timeoutMs}ms`);
    this.name = 'RunTimeoutError';
  }
}

export class RunFailedError extends BaseTypedError {
  readonly nextTool = 'get_findings';
  readonly hint = 'to inspect any partial results, or run_agent_on_pr again';

  constructor(
    public readonly runId: string,
    public readonly serverError: string,
  ) {
    super(`run \`${runId}\` failed: ${serverError}`);
    this.name = 'RunFailedError';
  }
}

export class ApiUnreachableError extends BaseTypedError {
  readonly nextTool = 'list_agents';
  readonly hint = 'once the DevDigest API is running at ${DEVDIGEST_API_URL}';

  constructor(
    public readonly url: string,
    public readonly cause: string,
  ) {
    super(`DevDigest API unreachable at ${url}: ${cause}`);
    this.name = 'ApiUnreachableError';
  }
}

/**
 * `get_blast_radius` is not implemented yet (planned as course slice C).
 * The message is a hard-coded literal, not composed from `nextTool`/`hint` —
 * `toMcpErrorContent()` is overridden to return it verbatim.
 */
export class NotImplementedError extends BaseTypedError {
  readonly nextTool = 'run_agent_on_pr';
  readonly hint = 'or list_agents in the meantime';

  constructor() {
    super(
      'get_blast_radius is not implemented yet — planned as course slice C. Call list_agents or run_agent_on_pr in the meantime.',
    );
    this.name = 'NotImplementedError';
  }

  override toMcpErrorContent(): McpErrorContent {
    return {
      isError: true,
      content: [{ type: 'text', text: this.message }],
    };
  }
}
