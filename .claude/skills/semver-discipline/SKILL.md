---
name: semver-discipline
description: Determine the required version bump (patch / minor / major) for a diff and verify the changelog/package version was actually bumped to match. Use when reviewing any PR that changes a published interface — HTTP routes, exported TS/Zod contracts, CLI flags, library entry points. Flag MUST when the diff contains a breaking change without a corresponding major bump, or removes/renames a public symbol without one.
---

# semver-discipline

Semantic versioning is a contract with consumers. Mis-bumping is itself a contract violation: it causes auto-update tools (renovate, dependabot, lockfile resolvers) to install incompatible code under a "safe" range.

## Decision tree

Given the set of contract-affecting changes in this PR, ask in order:

1. **Any breaking change?** (see [[breaking-change]] and [[response-schema]]) → **MAJOR**.
2. **Any new public surface added** (new endpoint, new optional field, new exported symbol, new CLI flag) and no breaking change? → **MINOR**.
3. **Only bug fixes, internal refactors, performance, or doc updates that don't change observable behavior?** → **PATCH**.

Pre-1.0 caveat: SemVer permits breaking changes in minor bumps below `1.0.0`. Apply this only if the project is explicitly pre-1.0 AND consumers are warned. Default to treating pre-1.0 the same as post-1.0 unless told otherwise — it costs nothing and prevents surprise.

## What MUST be checked in every PR

- The version field that consumers depend on (in this repo: each package's `package.json` `version`, and any published `CHANGELOG.md`).
- The change should appear in the changelog with the correct section header (`### Breaking`, `### Added`, `### Fixed`).
- For internal services without a published version, the discipline still applies: the `/v1` → `/v2` route prefix is the version. A breaking change on `/v1` is a major bump and needs a `/v2`.

## Examples

### BAD — breaking change, patch bump

```diff
 // package.json
-"version": "2.3.4",
+"version": "2.3.5",
```
…in a PR that also contains:
```diff
- export interface User { id: string; fullName: string }
+ export interface User { id: string; displayName: string }
```
**Verdict:** MUST. This is a `2.3.4 → 3.0.0` change. A `2.3.5` release will silently break every consumer on `^2.3.4`. Fix: bump to `3.0.0`, add a `### Breaking` changelog entry, OR keep both fields and downgrade the diff to a minor change.

### BAD — new endpoint, no bump

```diff
+ fastify.get('/api/users/:id/avatar', async (req) => { ... })
```
…with no `version` change and no changelog entry.
**Verdict:** MUST. Consumers can't discover the new capability via version probing. Fix: minor bump and a `### Added` line.

### GOOD — patch with no contract change

```diff
- const ttl = 5 * 60_000
+ const ttl = 10 * 60_000  // cache longer to reduce GitHub rate-limit pressure
```
…with `2.3.4 → 2.3.5`.
**Verdict:** OK. Behavior is observably faster/slower but the contract is unchanged.

### GOOD — major bump with deprecation window

```diff
 // package.json
-"version": "2.7.1",
+"version": "3.0.0",

 // contracts/user.ts
- /** @deprecated since 2.6 — use displayName */
- fullName: z.string(),
+ // removed in 3.0 per deprecation policy
 displayName: z.string(),
```
**Verdict:** OK. Field was deprecated in 2.6, removed in 3.0 — see [[deprecation-policy]].

## Cross-checks the reviewer must run

- `git diff main -- '**/package.json' | grep version` → did any version actually move?
- For each contract file in the diff, locate the changelog entry. If missing, flag SHOULD.
- If the diff contains a breaking change AND the version bump is not major, flag MUST.
- If the diff is a documented breaking change but the changelog header still says `### Fixed`, flag SHOULD.

## Checklist

- [ ] The largest change in the diff matches the version bump (major ≥ minor ≥ patch).
- [ ] The changelog reflects the change with the right section.
- [ ] If this is a service-internal `/v1` route, breaking changes live on `/v2` instead of mutating `/v1`.
