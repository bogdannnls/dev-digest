/**
 * Domain value types — pure TypeScript, no runtime code.
 *
 * These INLINE the shapes of the server's contracts (see
 * `server/src/vendor/shared/contracts/*`) rather than importing them, per the
 * plan: a tsconfig path alias into `server/src/vendor/shared/*` is deferred
 * until a task actually needs it (avoids coupling `mcp/` to `server/`'s
 * internal module layout prematurely).
 *
 * Fields whose optionality is ambiguous on the server default to optional
 * (`?`) here — cheaper for a port consumer than an over-strict required field.
 */

// ---- Agents --------------------------------------------------------------
// Mirrors `server/src/vendor/shared/contracts/knowledge.ts` `Agent`.
// T4 (list-agents service) narrows this to the concise `{id, name, description}`
// triple exposed to the `list_agents` tool.
export interface Agent {
  id: string;
  name: string;
  description: string;
  provider?: string;
  model?: string;
  system_prompt?: string;
  output_schema?: unknown;
  enabled?: boolean;
  version?: number;
  strategy?: string;
  ci_fail_on?: string;
  repo_intel?: boolean;
}

// ---- Repos ----------------------------------------------------------------
// Mirrors `server/src/vendor/shared/contracts/platform.ts` `Repo`
// (see also `toRepoDto` in `server/src/modules/repos/helpers.ts`).
export interface Repo {
  id: string;
  workspace_id?: string;
  owner?: string;
  name?: string;
  full_name: string;
  default_branch?: string;
  clone_path?: string | null;
  last_polled_at?: string | null;
  created_by?: string | null;
  provider?: 'github' | 'bitbucket';
}

// ---- Pull requests ----------------------------------------------------------
// Mirrors `server/src/vendor/shared/contracts/platform.ts` `PrMeta`/`PrDetail`
// (see `server/src/modules/pulls/routes.ts`). `id` is nullish on the server's
// `PrMeta` (a producer without a persisted id), but every DB-backed pull the
// port deals with has one, so it's required here for `findPullByNumber`
// callers plumbing `pullId` onward.
export interface Pull {
  id: string;
  repo_id: string;
  number: number;
  title?: string;
  author?: string;
  branch?: string;
  base?: string;
  head_sha?: string;
  additions?: number;
  deletions?: number;
  files_count?: number;
  status?: string;
  opened_at?: string | null;
  updated_at?: string | null;
  score?: number | null;
}

// ---- Findings ---------------------------------------------------------------
// Mirrors `server/src/vendor/shared/contracts/findings.ts` `FindingRecord`
// (Finding + persisted row identity/action timestamps).
export interface Finding {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
  severity: 'CRITICAL' | 'WARNING' | 'SUGGESTION';
  category?: string;
  title: string;
  rationale: string;
  suggestion?: string | null;
  confidence?: number;
  kind?: string | null;
  review_id?: string;
  accepted_at?: string | null;
  dismissed_at?: string | null;
}

// ---- Verdict ------------------------------------------------------------
// Server DB enum — mirrors `server/src/vendor/shared/contracts/findings.ts` `Verdict`.
export type Verdict = 'approve' | 'request_changes' | 'comment';

// ---- Run summaries -----------------------------------------------------------
// Mirrors `server/src/vendor/shared/contracts/trace.ts:94-114` `RunSummary`.
export interface RunSummary {
  run_id: string;
  agent_id: string | null;
  agent_name: string | null;
  status: 'running' | 'done' | 'failed' | 'cancelled' | null;
  error?: string | null;
  provider?: string | null;
  model?: string | null;
  duration_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  findings_count?: number | null;
  grounding?: string | null;
  ran_at?: string | null;
  score?: number | null;
  blockers?: number | null;
}

// ---- Reviews ------------------------------------------------------------
// Mirrors `server/src/vendor/shared/contracts/review-api.ts` `ReviewRecord`.
export interface ReviewDto {
  id?: string;
  pr_id?: string;
  agent_id?: string | null;
  run_id: string | null;
  agent_name?: string | null;
  kind?: 'summary' | 'review';
  verdict: Verdict | null;
  summary?: string | null;
  score: number | null;
  model?: string | null;
  grounding?: string | null;
  created_at: string;
  findings: Finding[];
}

// ---- Conventions --------------------------------------------------------
// Mirrors the conventions service's return shape
// (`server/src/modules/conventions/service.ts` `ConventionDto` /
// `server/src/vendor/shared/contracts/knowledge.ts` `ConventionCandidate`).
export interface ConventionCandidate {
  id: string;
  category: string;
  rule: string;
  evidence_path?: string | null;
  evidence_snippet?: string | null;
  evidence_start_line?: number | null;
  evidence_end_line?: number | null;
  confidence?: number | null;
  accepted: boolean;
  created_at: string;
}

// ---- Tool-facing run result ----------------------------------------------
// The 3-state verdict surfaced by `run_agent_on_pr` (T7). `clean`/`issues`/`error`
// collapse the server's richer verdict + run-status combinations (see T7 mapping
// table in the plan).
export interface RunResult {
  runId: string;
  verdict: 'clean' | 'issues' | 'error';
  findings: Finding[];
  truncated?: boolean;
}
