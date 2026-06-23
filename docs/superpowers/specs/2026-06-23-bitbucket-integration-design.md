# Bitbucket Cloud Integration — Design Spec

**Date:** 2026-06-23  
**Status:** Approved  
**Scope:** Add Bitbucket Cloud as a second VCS provider alongside GitHub, with full feature parity (PR list, PR detail, post review, inline comments, open PR, commit files, find open PR, get issue).

---

## 1. Goals

- Users can add a Bitbucket Cloud repository by pasting its URL, exactly as they do today for GitHub.
- All review features work against Bitbucket PRs: list, detail, run review, post findings as comments.
- CI-automation features (`commitFiles`, `openPullRequest`, `findOpenPr`) are supported for Bitbucket.
- Authentication uses Bitbucket App Password (username + token), matching the local-first UX of the existing GitHub PAT flow.
- Provider is auto-detected from the repo URL — users never pick it manually.

---

## 2. Out of scope

- Bitbucket Server / Data Center (different API, different auth — separate future spec).
- OAuth 2.0 for Bitbucket (App Password is sufficient for local-first use).
- Webhook-triggered automatic reviews (not implemented for GitHub either).

---

## 3. Data layer

### 3.1 Migration: `provider` column on `repos`

New migration adds a `provider` column to the `repos` table:

```sql
ALTER TABLE repos ADD COLUMN provider text NOT NULL DEFAULT 'github';
```

Existing rows are backfilled to `'github'` via the column default. The column is `NOT NULL` — all future inserts must supply a provider.

### 3.2 Contract update

`vendor/shared/contracts/platform.ts` — the `Repo` Zod schema gains:

```ts
provider: z.enum(['github', 'bitbucket-cloud']),
```

`RepoInput` stays as `{ url: string }` — provider is derived from the URL, never sent by the client.

### 3.3 Secrets

Two new secret keys added to the `SecretKey` union in `adapters.ts`:

- `BITBUCKET_USERNAME` — Atlassian account username (e.g. `jdoe`)
- `BITBUCKET_APP_PASSWORD` — App Password with scopes: `pullrequests:read`, `pullrequests:write`, `issues:read`, `repositories:read`

Stored and retrieved via `SecretsProvider` exactly like `GITHUB_TOKEN`.

---

## 4. Interface layer

### 4.1 Rename `GitHubClient` → `VcsClient`

All GitHub-specific naming in `vendor/shared/adapters.ts` is renamed:

| Before | After |
|--------|-------|
| `GitHubClient` | `VcsClient` |
| `GitHubReviewPayload` | `VcsReviewPayload` |
| `ContainerOverrides.github` | `ContainerOverrides.vcs` |

The interface **shape is unchanged** — this is a mechanical rename only. All imports across `server/` and test files are updated accordingly.

### 4.2 Bitbucket Cloud adapter

New file: `server/src/adapters/bitbucket/cloud.ts`

- Class: `BitbucketCloudClient implements VcsClient`
- Auth: `Authorization: Basic base64(username:app_password)` on every request
- HTTP: native `fetch` (no SDK dependency)
- Base URL: `https://api.bitbucket.org/2.0`
- Pagination: Bitbucket returns paginated responses (`{ values, next }`); the adapter exhausts all pages for list calls.

**API method mapping:**

| `VcsClient` method | Bitbucket Cloud API |
|---|---|
| `listPullRequests` | `GET /repositories/{ws}/{slug}/pullrequests?state=OPEN,MERGED,DECLINED&pagelen=50` |
| `getPullRequest` | `GET /repositories/{ws}/{slug}/pullrequests/{id}` + `/diffstat` + `/commits` |
| `postReview` | `POST /approve` (APPROVE), `POST /request-changes` (REQUEST_CHANGES), `POST /comments` (COMMENT) |
| `listReviewComments` | `GET /repositories/{ws}/{slug}/pullrequests/{id}/comments` |
| `createReviewComment` | `POST /repositories/{ws}/{slug}/pullrequests/{id}/comments` with inline `anchor` object |
| `openPullRequest` | `POST /repositories/{ws}/{slug}/pullrequests` |
| `commitFiles` | `POST /repositories/{ws}/{slug}/src` (multipart form, one file per part) |
| `findOpenPr` | `GET /repositories/{ws}/{slug}/pullrequests?q=source.branch.name="{branch}"&state=OPEN` |
| `getIssue` | `GET /repositories/{ws}/{slug}/issues/{id}` |
| `currentLogin` | `GET /user` |

**Field mapping notes:**
- Bitbucket PR `source.branch.name` → `branch`; `destination.branch.name` → `base`
- `author.display_name` → `author`
- `source.commit.hash` → `head_sha`
- Inline comment anchor: `{ path, line, line_type: 'ADDED' }` (Bitbucket uses `line_type` instead of GitHub's `side`)
- `postReview` maps `APPROVE` → `POST /approve`, `REQUEST_CHANGES` → `POST /request-changes`, `COMMENT` → `POST /comments` (PR-level summary comment). The `body` field of the payload is always posted as a comment regardless of event type, so the verdict text is always visible on the PR.

### 4.3 Container update

`container.github()` → `container.vcsClient(repo: { provider: string }): Promise<VcsClient>`

```ts
async vcsClient(repo: { provider: string }): Promise<VcsClient> {
  if (repo.provider === 'bitbucket-cloud') {
    // lazily construct BitbucketCloudClient from secrets
  }
  // default: OctokitGitHubClient (existing behaviour)
}
```

Separate lazy-cached instances for each provider. `invalidateSecretCaches()` clears both.

`ContainerOverrides` gains `vcs?: VcsClient` (replaces `github?: GitHubClient`) for test injection.

---

## 5. Repos module

### 5.1 URL parsing

`helpers.ts` — `parseRepoUrl()` extended to return `{ owner, name, provider }`:

**Supported URL forms:**

| URL | provider |
|-----|----------|
| `https://github.com/owner/repo` | `github` |
| `git@github.com:owner/repo.git` | `github` |
| `https://bitbucket.org/workspace/repo` | `bitbucket-cloud` |
| `git@bitbucket.org:workspace/repo.git` | `bitbucket-cloud` |

Unrecognised hostnames throw `AppError('invalid_repo_url', ...)` as before.

### 5.2 Clone URL authentication

`withGitHubToken()` → `withVcsToken()`:

- GitHub https URLs: embed `x-access-token:<token>` (existing behaviour)
- Bitbucket https URLs: embed `<username>:<app_password>`
- SSH URLs: left untouched (SSH key auth handles it)

Clone job reads provider from the repo row, fetches the appropriate secrets, and calls `withVcsToken()`.

### 5.3 Repo persistence

`RepoService.add()` passes the detected `provider` to the repository insert. `fullName` for Bitbucket repos follows the same `workspace/slug` format already used.

---

## 6. Pulls & reviews modules

Every `container.github()` call in `modules/pulls/routes.ts` and `modules/reviews/` that has a `repo` in scope becomes `container.vcsClient(repo)`.

No logic changes in the route handlers — the adapter absorbs all API differences. The review engine in `reviewer-core` is untouched (it works on diffs, not provider APIs).

---

## 7. Settings UI (client)

`client/` settings page gains a **Bitbucket** section with two fields:

- **Username** — maps to `BITBUCKET_USERNAME` secret
- **App Password** — maps to `BITBUCKET_APP_PASSWORD` secret

Scopes required (shown as helper text): `pullrequests:read`, `pullrequests:write`, `issues:read`, `repositories:read`.

No changes to the "Add repository" UI — provider is auto-detected from the URL.

---

## 8. Testing strategy

### Unit tests

- `server/src/adapters/bitbucket/cloud.test.ts` — `BitbucketCloudClient` with `fetch` mocks. Cover: list PRs, get PR detail, post review, create inline comment, auth header shape, pagination (multi-page `next` cursor traversal).
- `server/src/modules/repos/helpers.test.ts` — extend existing tests to cover Bitbucket URL parsing (https + ssh, with and without `.git`).

### Integration tests

No new live-API integration tests. Existing route-layer integration tests use mock `VcsClient` adapters; after the rename they continue to work unchanged.

### Contract tests (manual / optional)

`server/src/adapters/bitbucket/cloud.contract.it.test.ts` — hits the real Bitbucket API, guarded by `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD` env vars. Excluded from standard CI. Validates that the adapter returns shapes conforming to `PrMeta` and `PrDetail` Zod schemas.

### Migration test

Existing migration integration tests cover the new `provider` column and its `github` default — no extra work needed.

---

## 9. Implementation order

1. Migration (`provider` column)
2. Contract + secrets update (`VcsClient` rename, `Repo` schema, `SecretKey`)
3. Container update (`vcsClient()` method)
4. `BitbucketCloudClient` adapter + unit tests
5. `helpers.ts` URL parsing + `withVcsToken()` + unit tests
6. Route updates (`pulls`, `reviews`, `repos` — swap `container.github()`)
7. Settings UI (Bitbucket credentials section)
8. Contract test (manual verification against real Bitbucket API)
