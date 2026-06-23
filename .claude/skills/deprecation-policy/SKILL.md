---
name: deprecation-policy
description: Ensure that removals, renames, or behavior changes go through a deprecation window with visible signals — never a silent deletion. Use when reviewing diffs that remove or rename endpoints, request/response fields, exported symbols, CLI flags, or webhook/SSE events. Flag MUST when something publicly used disappears with no `@deprecated` marker, no `Deprecation`/`Sunset` header, no changelog entry, and no documented replacement.
---

# deprecation-policy

Removing public surface in one shot punishes every consumer who didn't read the diff. A proper deprecation:

1. **Announces** — `@deprecated` JSDoc, OpenAPI `deprecated: true`, changelog entry, ideally a runtime `Deprecation` / `Sunset` HTTP header.
2. **Points** — names the replacement (`use displayName instead`).
3. **Waits** — old + new coexist for at least one minor version (or one quarter for paid APIs) before removal.
4. **Removes** — only in the next major version, with a `### Breaking` changelog line.

Severity: **MUST** when something is removed/renamed with no announcement. **SHOULD** when it's announced but the wait window is too short.

## Required signals

| Surface | Signal |
|---|---|
| HTTP endpoint | `Deprecation: <date>` + `Sunset: <date>` headers, OpenAPI `deprecated: true` |
| Response field | Keep returning the field; add `@deprecated` JSDoc on the schema; document replacement |
| Request field | Keep accepting it; warn-log on use; document replacement |
| Exported TS symbol | `/** @deprecated since X.Y — use Z */` JSDoc tag |
| CLI flag | Keep parsing it; print a stderr warning on use |
| SSE event / webhook | Keep emitting alongside the new event for one minor version |

## Examples

### BAD — silent removal

```diff
 export const UserDTO = z.object({
   id: z.string(),
-  fullName: z.string(),
   displayName: z.string(),
 })
```
…no JSDoc deprecation in the previous release, no changelog, no `displayName` predecessor announcement.
**Verdict:** MUST. Clients break overnight. Fix: revert the removal, ship a release that keeps both fields with `fullName` marked `@deprecated`, wait one minor, then remove in the next major. See [[semver-discipline]].

### BAD — endpoint removed without Sunset

```diff
- fastify.get('/api/v1/legacy-search', legacySearchHandler)
```
…and OpenAPI no longer lists it.
**Verdict:** MUST. Existing integrations 404 with no warning. Fix: keep the route, mark `deprecated: true` in OpenAPI, set `Deprecation: true` and `Sunset: <UTC date ≥ 90 days out>` response headers, document the replacement in the changelog. Remove only after the sunset date in the next major.

### GOOD — staged removal across two releases

```ts
// release 2.6.0 — announce
export const UserDTO = z.object({
  id: z.string(),
  /** @deprecated since 2.6 — use `displayName`. Removed in 3.0. */
  fullName: z.string(),
  displayName: z.string(),
})
```
```ts
// release 3.0.0 — remove
export const UserDTO = z.object({
  id: z.string(),
  displayName: z.string(),
})
```
Changelog 2.6: `### Deprecated — UserDTO.fullName, use displayName. Removal in 3.0.`
Changelog 3.0: `### Breaking — UserDTO.fullName removed (deprecated since 2.6).`
**Verdict:** OK. Consumers had a full minor cycle to migrate, the announcement was in code + changelog, the replacement was named.

### GOOD — endpoint deprecation with HTTP signals

```ts
fastify.get('/api/v1/legacy-search', async (req, reply) => {
  reply.header('Deprecation', 'true')
  reply.header('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT')
  reply.header('Link', '</api/v2/search>; rel="successor-version"')
  return legacySearchHandler(req)
})
```
**Verdict:** OK. Operators can grep their logs for `Deprecation: true` responses and migrate before sunset.

## Checklist

- [ ] Nothing public is removed in the same release it was deprecated.
- [ ] Every removed/renamed symbol had a prior release shipping it with `@deprecated`.
- [ ] HTTP endpoint removals have `Deprecation` + `Sunset` headers for ≥ one minor release.
- [ ] The replacement is named in code (`@deprecated since X — use Y`) and the changelog.
- [ ] Removal lands in a major version, paired with a `### Breaking` changelog line.
