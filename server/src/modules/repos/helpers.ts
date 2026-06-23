import { type Repo } from '@devdigest/shared';
import * as t from '../../db/schema.js';
import { AppError } from '../../platform/errors.js';
import {
  GITHUB_URL_REGEX,
  GIT_TOKEN_USERNAME,
  GITHUB_HTTPS_HOST,
  BITBUCKET_URL_REGEX,
  BITBUCKET_HTTPS_HOST,
  BITBUCKET_OAUTH_TOKEN_USERNAME,
} from './constants.js';

/**
 * F1 — repos pure helpers (extracted from routes.ts; no behaviour change).
 * Pure functions only — no I/O, no DB, no container.
 */

/** Detect which forge hosts the URL. */
export function detectProvider(url: string): 'github' | 'bitbucket' {
  return url.includes('bitbucket.org') ? 'bitbucket' : 'github';
}

/** Parse `owner`/`name`/`provider` from a GitHub or Bitbucket URL (https or ssh form). */
export function parseRepoUrl(url: string): { owner: string; name: string; provider: 'github' | 'bitbucket' } {
  const provider = detectProvider(url);
  const regex = provider === 'bitbucket' ? BITBUCKET_URL_REGEX : GITHUB_URL_REGEX;
  const match = url.match(regex);
  if (!match?.[1] || !match[2]) {
    throw new AppError('invalid_repo_url', `Could not parse owner/repo from '${url}'`, 400);
  }
  return { owner: match[1], name: match[2], provider };
}

/**
 * Embed credentials into an https forge URL so private clones authenticate
 * non-interactively. SSH and unrecognised URLs are left untouched.
 *
 * For GitHub: uses `x-access-token:<token>`.
 * For Bitbucket OAuth token: uses `x-token-auth:<token>`.
 * For Bitbucket app password: uses `<username>:<appPassword>`.
 * Token takes precedence over appPassword when both are supplied.
 */
export function withForgeToken(
  url: string,
  provider: 'github' | 'bitbucket',
  auth: { token?: string; username?: string; appPassword?: string },
): string {
  try {
    const u = new URL(url);
    const isGitHub = provider === 'github' && u.hostname === GITHUB_HTTPS_HOST;
    const isBitbucket = provider === 'bitbucket' && u.hostname === BITBUCKET_HTTPS_HOST;
    if (u.protocol !== 'https:' || (!isGitHub && !isBitbucket)) return url;

    if (auth.token) {
      u.username = provider === 'github' ? GIT_TOKEN_USERNAME : BITBUCKET_OAUTH_TOKEN_USERNAME;
      u.password = auth.token;
      return u.toString();
    }
    if (provider === 'bitbucket' && auth.username && auth.appPassword) {
      u.username = auth.username;
      u.password = auth.appPassword;
      return u.toString();
    }
  } catch {
    /* non-URL (e.g. git@bitbucket.org:...) — leave as-is */
  }
  return url;
}

/** Map a persisted repo row to the API `Repo` DTO. */
export function toRepoDto(row: typeof t.repos.$inferSelect): Repo {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    owner: row.owner,
    name: row.name,
    full_name: row.fullName,
    default_branch: row.defaultBranch,
    clone_path: row.clonePath,
    last_polled_at: row.lastPolledAt?.toISOString() ?? null,
    created_by: row.createdBy,
    provider: (row.provider ?? 'github') as 'github' | 'bitbucket',
  };
}
