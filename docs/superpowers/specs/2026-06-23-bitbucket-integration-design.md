# Bitbucket Integration Design

**Date:** 2026-06-23
**Status:** Approved
**Scope:** Full parity with GitHub — Bitbucket Cloud only (bitbucket.org)

---

## 1. Overview

Add Bitbucket Cloud as a first-class forge provider alongside GitHub. Users can add Bitbucket repos by URL, import PRs, view diffs, run AI reviews, and post review comments back — identical to the GitHub workflow.

The integration is anchored by three decisions:
1. Rename `GitHubClient` → `ForgeClient` (the interface was always provider-agnostic in purpose).
2. Add a `provider` column to the `repos` table to carry provider context through every operation.
3. Implement `BitbucketClient` behind the `ForgeClient` interface using Bitbucket Cloud REST API v2.

---

## 2. Architecture

```
URL input (bitbucket.org/…)
    ↓ detectProvider()
repos.provider = 'bitbucket'   ← new DB column, default 'github'
    ↓
container.forgeClient('bitbucket')   ← replaces container.github()
    ↓
BitbucketClient (new)   ← implements ForgeClient (renamed from GitHubClient)
    ↓
Bitbucket Cloud REST API v2 (api.bitbucket.org/2.0)
```

**Renamed symbols:**
- Interface: `GitHubClient` → `ForgeClient`
- Payload type: `GitHubReviewPayload` → `ForgeReviewPayload`
- Container method: `container.github()` → `container.forgeClient(provider)`
- Helper: `withGitHubToken` → `withForgeToken`

**Class names stay descriptive:** `OctokitGitHubClient` keeps its name (it is the GitHub implementation). `BitbucketClient` is new.

All 10 interface methods are unchanged in signature. Bitbucket-specific semantics are encapsulated entirely inside `BitbucketClient`.

---

## 3. Data Model

### 3.1 `repos` table migration

New migration file: `server/src/db/migrations/XXXX_add_provider_to_repos.sql`

```sql
ALTER TABLE repos
  ADD COLUMN provider text NOT NULL DEFAULT 'github'
  CHECK (provider IN ('github', 'bitbucket'));
```

Existing rows silently get `'github'`. No backfill required.

### 3.2 Secrets

Three new keys added to the `SecretKey` union in `adapters.ts`:

| Key | Purpose |
|-----|---------|
| `BITBUCKET_TOKEN` | OAuth 2.0 bearer token (used first when present) |
| `BITBUCKET_USERNAME` | App Password auth — username |
| `BITBUCKET_APP_PASSWORD` | App Password auth — credential |

Clone URL authentication by strategy:
- OAuth: `https://x-token-auth:{BITBUCKET_TOKEN}@bitbucket.org/…`
- App Password: `https://{USERNAME}:{APP_PASSWORD}@bitbucket.org/…`

Token takes precedence when both are configured.

### 3.3 Shared contract changes

- `SecretsStatus` — adds `bitbucket: boolean`
- `ConnTestProvider` — adds `'bitbucket'`
- `Repo` DTO — adds `provider: 'github' | 'bitbucket'`

---

## 4. ForgeClient Interface

Rename `GitHubClient` → `ForgeClient` in `server/src/vendor/shared/adapters.ts`. The method signatures are identical. `GitHubReviewPayload` → `ForgeReviewPayload` (same shape).

Files affected by the rename (~10 files):
- `server/src/vendor/shared/adapters.ts`
- `server/src/platform/container.ts`
- `server/src/adapters/github/octokit.ts` (class implements `ForgeClient`)
- `server/src/adapters/mocks.ts`
- `server/src/modules/repos/service.ts`
- `server/src/modules/pulls/service.ts`
- `server/src/modules/settings/routes.ts`
- Any test files importing `GitHubClient`

---

## 5. BitbucketClient Adapter

**Location:** `server/src/adapters/bitbucket/rest.ts`

**Constructor:**
```ts
new BitbucketClient({ token?: string; username?: string; appPassword?: string })
```
Builds the `Authorization` header once at construction time. OAuth: `Bearer {token}`. App Password: `Basic {base64(username:appPassword)}`. Token wins if both are present.

**HTTP client:** Plain `fetch` (Node 22 built-in). Wraps all calls with the existing `withRetry`/`withTimeout` from `platform/resilience.ts`. No new dependency.

**Pagination:** Bitbucket uses cursor-based pagination via a `next` link in responses. All list methods follow `next` until exhausted, capped at the same limits as the GitHub adapter (50 PRs, 100 files/commits).

### 5.1 Method mapping

| `ForgeClient` method | Bitbucket Cloud REST API v2 |
|---|---|
| `listPullRequests` | `GET /repositories/{ws}/{repo}/pullrequests?state=ALL&sort=-updated_on&pagelen=50` |
| `getPullRequest` | `GET /…/pullrequests/{id}` + `/diff` + `/commits` + linked issue from PR description |
| `postReview` | `POST /…/approve` (APPROVE), `POST /…/request-changes` (REQUEST_CHANGES), no-op state change (COMMENT) + individual `POST /…/comments` for each inline comment |
| `listReviewComments` | `GET /…/pullrequests/{id}/comments` — filter to entries with `inline` field present |
| `createReviewComment` | `POST /…/pullrequests/{id}/comments` with `inline: { path, to: lineNumber }` |
| `openPullRequest` | `POST /repositories/{ws}/{repo}/pullrequests` |
| `commitFiles` | `POST /repositories/{ws}/{repo}/src` (multipart/form-data; creates branch if absent) |
| `findOpenPr` | `GET /…/pullrequests?q=source.branch.name="{branch}"+AND+state="OPEN"&pagelen=1` |
| `getIssue` | `GET /repositories/{ws}/{repo}/issues/{id}` — returns `undefined` on 404 (issues may be disabled) |
| `currentLogin` | `GET /user` |

**Note on `postReview`:** Bitbucket has no single "submit review with event + comments" endpoint. The adapter fans it out internally (approve/reject endpoint → then inline comments one by one). From the caller's perspective it is one awaited call.

---

## 6. Container Wiring

### 6.1 `container.forgeClient(provider)`

Replace `container.github(): Promise<ForgeClient>` with:

```ts
async forgeClient(provider: 'github' | 'bitbucket'): Promise<ForgeClient>
```

Caches one client per provider (same lazy pattern as `llmCache`). Bitbucket path: reads `BITBUCKET_TOKEN` first, falls back to `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`, throws `ConfigError` if neither is set.

`invalidateSecretCaches()` clears both cached clients.

### 6.2 `ContainerOverrides`

```ts
// before
github?: GitHubClient

// after
forge?: Partial<Record<'github' | 'bitbucket', ForgeClient>>
```

### 6.3 Caller updates

| Caller | Change |
|---|---|
| `RepoService.runCloneJob` | Read `provider` from payload, call `forgeClient(provider)` for clone auth |
| `RepoService.refresh` | Build clone URL from `provider` + `fullName` (removes hardcoded `github.com`) |
| `PullsService` | Pass `repo.provider` to `forgeClient(repo.provider)` |
| `settings/routes.ts` | Add `'bitbucket'` branch to connection test handler |

---

## 7. URL Parsing & Clone Auth

### 7.1 Provider detection

New helper in `server/src/modules/repos/helpers.ts`:

```ts
function detectProvider(url: string): 'github' | 'bitbucket'
```

Returns `'bitbucket'` if the URL contains `bitbucket.org`, `'github'` otherwise.

### 7.2 `parseRepoUrl` return type

Extended to return `{ owner, name, provider }`. Two regex constants in `repos/constants.ts`:

- `GITHUB_URL_REGEX` — existing, unchanged
- `BITBUCKET_URL_REGEX` — handles `https://bitbucket.org/ws/repo(.git)` and `git@bitbucket.org:ws/repo.git`

### 7.3 `withForgeToken`

Replaces `withGitHubToken`. Signature:

```ts
function withForgeToken(
  url: string,
  provider: 'github' | 'bitbucket',
  auth: { token?: string; username?: string; appPassword?: string }
): string
```

| Provider + auth | Injected URL format |
|---|---|
| github | `https://x-access-token:{token}@github.com/…` |
| bitbucket OAuth | `https://x-token-auth:{token}@bitbucket.org/…` |
| bitbucket App Password | `https://{username}:{appPassword}@bitbucket.org/…` |

New constants in `repos/constants.ts`:
- `BITBUCKET_URL_REGEX`
- `BITBUCKET_HTTPS_HOST = 'bitbucket.org'`
- `BITBUCKET_OAUTH_TOKEN_USERNAME = 'x-token-auth'`

---

## 8. Settings & UI

### 8.1 Server

`ConnTestRequest` body schema is extended: alongside the existing `{ provider, key? }` shape, Bitbucket adds optional `{ username?, appPassword? }` fields. The handler persists whichever fields are non-empty to `SecretsProvider` before testing:
- `key` → `BITBUCKET_TOKEN`
- `username` → `BITBUCKET_USERNAME`
- `appPassword` → `BITBUCKET_APP_PASSWORD`

`SECRET_KEY_BY_PROVIDER` maps `'bitbucket'` → `'BITBUCKET_TOKEN'` for the single-key path (OAuth). App Password fields are persisted directly in the bitbucket branch of the handler.

`settings/routes.ts` — `test-connection` adds a `'bitbucket'` branch: persists supplied credentials, calls `forgeClient('bitbucket')`, calls `currentLogin()`, returns `{ ok: true, message: 'Connected as @{username}' }`.

### 8.2 Client (Next.js)

The API Keys panel adds a **Bitbucket** section with:
- **OAuth token** field → `BITBUCKET_TOKEN` (sent as `key` in test-connection body)
- **App Password** section: username field (`BITBUCKET_USERNAME`) + app password field (`BITBUCKET_APP_PASSWORD`) (sent as `username` + `appPassword` in test-connection body)
- "Test connection" button (same pattern as GitHub) — the button submits whichever fields are filled
- Note: "OAuth token is used if both are configured."

The repo card in the repository list shows a provider logo badge (Bitbucket mark vs GitHub mark), driven by `repo.provider`.

No change to the "Add repository" URL input — provider detection is server-side.

---

## 9. Error Handling

`BitbucketClient` maps Bitbucket HTTP responses to the same `AppError` types used throughout the stack:

| Bitbucket status | `AppError` code | HTTP status |
|---|---|---|
| 401 | `unauthorized` | 401 |
| 403 | `forbidden` | 403 |
| 404 | `not_found` | 404 |
| 429 | retry via `withRetry` | — |
| 5xx | retry via `withRetry` | — |

404 from the issues endpoint is swallowed and returns `undefined` (same as `resolveLinkedIssue` in `OctokitGitHubClient`).

---

## 10. Testing

| What | File | Method |
|---|---|---|
| `BitbucketClient` (all 10 methods) | `adapters/bitbucket/rest.test.ts` | Mock `fetch` with `vi.fn()` — no network |
| `detectProvider` / `parseRepoUrl` Bitbucket paths | `modules/repos/helpers.test.ts` | Extend existing pure-function tests |
| `withForgeToken` Bitbucket paths | `modules/repos/helpers.test.ts` | Pure function |
| Connection test Bitbucket branch | `modules/settings/routes.test.ts` | Inject mock `ForgeClient` via `ContainerOverrides` |
| `RepoService.runCloneJob` Bitbucket path | `modules/repos/service.test.ts` | Mock `forgeClient` + `git.clone` |

No new integration tests required. The existing integration suite covers the full clone→index→review pipeline; the provider abstraction means Bitbucket slots in transparently once unit tests pass.

---

## 11. Out of Scope

- Bitbucket Data Center (self-hosted) — additive change if needed; does not affect this design
- Per-repo credentials (different token per workspace/org) — can be retrofitted via `clientFor(repo)` factory
- Bitbucket webhooks / push-triggered reviews
- Bitbucket Pipelines integration
