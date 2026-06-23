---
name: response-schema
description: Detect drift in API response shape — field types, optionality, nullability, enum values, default values, array element shape, pagination envelope. Use when reviewing diffs that change Zod/JSON-Schema/OpenAPI/TS types backing a response, or modify a handler's return value. Flag MUST when existing clients reading the previous shape would produce undefined values, runtime type errors, or wrong UI states.
---

# response-schema

Response schema drift is the most common silent breakage: the server still returns 200, but clients render `undefined`, crash on `null`, or misbehave on a new enum value. Be strict here.

## What to inspect

For every response touched in the diff, compare field-by-field against the previous version:

1. **Presence** — is every previously-returned field still returned?
2. **Type** — is the JS/JSON type identical?
3. **Optionality** — was a field always present and is now sometimes missing?
4. **Nullability** — was a field non-null and can now be `null`?
5. **Enum membership** — were values removed, or new values added that strict clients would reject?
6. **Array element shape** — did the element type narrow/widen?
7. **Defaults** — did the server start omitting a value that used to be populated?
8. **Envelope** — pagination, error wrapper, top-level keys.

## Severity map

| Change | Severity |
|---|---|
| Field removed | **MUST** |
| Field renamed | **MUST** |
| Type changed (`string → number`) | **MUST** |
| Required → optional (now sometimes absent) | **MUST** |
| Non-null → nullable | **MUST** unless clients verified null-safe |
| Enum value removed | **MUST** |
| Enum value added | **SHOULD** (strict-parsing clients break) |
| New optional field added | OK (informational) |
| Type widened in a safe direction (`literal "x" → string`) | **SHOULD** — clients narrowing on literal break |
| Array element gains an optional field | OK |

## Examples

### BAD — nullable creep

```diff
 export const PullRequestDTO = z.object({
   id: z.number(),
   title: z.string(),
-  author: z.object({ login: z.string(), avatarUrl: z.string() }),
+  author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
 })
```
**Verdict:** MUST. UI code rendering `pr.author.login` now crashes for ghost-authored PRs. Fix: keep non-nullable and synthesize a placeholder author on the server, OR roll a new field `authorOrNull` and deprecate `author`, OR major-bump.

### BAD — enum value silently added

```diff
 export const RunStatus = z.enum(['queued', 'running', 'succeeded', 'failed'])
+// new emitted value, schema not updated:
+export const RunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
```
**Verdict:** SHOULD (server is honest about it) → **MUST** if any client uses `switch(status)` with no default. Fix: ensure every consumer has a default branch; if not feasible, version the endpoint. Always changelog enum additions.

### BAD — pagination envelope changed

```diff
- return { items, total }
+ return { data: items, meta: { total, page, pageSize } }
```
**Verdict:** MUST. Every consumer breaks. Fix: keep the old envelope on `/v1/...`, ship the new envelope on `/v2/...`.

### GOOD — additive optional field

```diff
 export const RepoDTO = z.object({
   id: z.string(),
   name: z.string(),
+  archivedAt: z.string().datetime().nullable().optional(),
 })
```
**Verdict:** OK. Old clients ignore unknown fields. Document in changelog as a feature, not a contract change.

### GOOD — narrowing a request enum (request, not response)

This skill is about responses. Narrowing request enums is the `breaking-change` skill's territory — defer there.

## Checklist

- [ ] Every previously-returned field is still returned with the same name, type, presence, and nullability.
- [ ] No enum value was removed from a response enum.
- [ ] Pagination/error envelope unchanged.
- [ ] If a field was added, it's optional from the consumer's perspective (or it's a major version).
- [ ] OpenAPI/Zod/TS reflect what the handler actually returns. Read the handler — schemas lie.
