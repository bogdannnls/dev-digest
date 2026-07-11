/**
 * Domain error taxonomy + structured API error envelope. The UX taxonomy
 * (toast/inline/full-screen) is the frontend's concern; the API returns a
 * stable structured body (ApiErrorBody): { error: { code, message, details } }.
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', details?: unknown) {
    super('not_found', message, 404, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super('validation_error', message, 422, details);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, details?: unknown) {
    super('external_service_error', message, 502, details);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super('config_error', message, 500, details);
  }
}

/**
 * Thrown by in-memory server-side rate limiters (e.g. `IntentService`'s
 * per-workspace/per-PR compute limits). Not backed by `@fastify/rate-limit` —
 * see `IntentService` docstring for why. `statusCode: 429` flows through the
 * app's existing `AppError` → HTTP mapping with no route-level special-casing.
 */
export class RateLimitedError extends AppError {
  constructor(message: string, details?: { retryAfterSeconds?: number }) {
    super('rate_limited', message, 429, details);
  }
}

/**
 * Thrown by `modules/context` (Project Context reader, L05 T1) when a repo
 * row exists but has no clone on disk yet. Distinct from `NotFoundError`
 * (repo row itself missing) and from an empty discovered-document list (repo
 * IS cloned, just has zero matching `.md` files) — AC-4 requires the client
 * be able to tell these three states apart.
 */
export class RepoNotClonedError extends AppError {
  constructor(message = 'Repo has not been cloned yet', details?: unknown) {
    super('repo_not_cloned', message, 409, details);
  }
}
