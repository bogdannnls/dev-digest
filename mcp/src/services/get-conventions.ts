/**
 * `getConventions` — service backing the `get_conventions` tool.
 *
 * Flow: resolve `repo` (full_name `owner/name`) to a `Repo` via the port,
 * then list its convention candidates. Empty conventions is a valid state
 * (repo may not have been scanned yet) — returns `{ conventions: [] }`
 * rather than throwing.
 *
 * Errors (e.g. `ApiUnreachableError` from `port.listConventions()`) are not
 * caught here — they propagate to the tool handler registered in T9, which
 * centrally converts typed errors into MCP error content (rule A2 — this
 * file never does `throw new Error(...)`).
 */

import type { ConventionCandidate, DevDigestPort } from '../domain/ports.js';
import { RepoNotFoundError } from '../platform/errors.js';

export interface GetConventionsInput {
  repo: string;
}

export interface GetConventionsResult {
  conventions: Array<{
    rule: string;
    category: string;
    accepted: boolean;
  }>;
}

export async function getConventions(
  port: DevDigestPort,
  input: GetConventionsInput,
): Promise<GetConventionsResult> {
  const repo = await port.findRepoByFullName(input.repo);
  if (!repo) throw new RepoNotFoundError(input.repo);

  const candidates = await port.listConventions(repo.id);
  return { conventions: candidates.map(toConciseConvention) };
}

/**
 * Concise mapping (rule P-concise). Chosen field set:
 * - Include: `rule` (the rule text itself — fatal if missing), `category`
 *   (groups related rules), `accepted` (acceptance status — lets a caller
 *   distinguish confirmed conventions from pending candidates).
 * - Exclude: `id` (internal identifier), `created_at` (timestamp),
 *   `evidence_path` / `evidence_snippet` / `evidence_start_line` /
 *   `evidence_end_line` (provenance metadata pointing at where the rule was
 *   extracted from), `confidence` (extractor-internal score).
 */
function toConciseConvention(c: ConventionCandidate): {
  rule: string;
  category: string;
  accepted: boolean;
} {
  return {
    rule: c.rule,
    category: c.category,
    accepted: c.accepted,
  };
}
