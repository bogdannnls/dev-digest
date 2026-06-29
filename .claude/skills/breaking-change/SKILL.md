---
name: breaking-change
description: Detect changes that remove or alter a published API contract in a way existing clients cannot tolerate. Use when reviewing diffs that touch HTTP routes, request/response DTOs, Zod/OpenAPI/GraphQL schemas, exported TS contract types, webhook/SSE payloads, or auth requirements. Flag as MUST when any consumer pinned to the previous shape would break at runtime.
---

# breaking-change

A change is **breaking** if a correct client written against the previous contract can no longer succeed after the change. Severity: **MUST** (blocker) unless behind a separate, opt-in version/route.

## Red flags — always MUST

- Endpoint removed or renamed: `DELETE /api/v1/users` → gone, or path changed.
- HTTP method changed on an existing path.
- Required request field added (server now rejects old clients).
- Existing request field becomes required (was optional → mandatory).
- Response field removed or renamed (clients reading `user.fullName` break).
- Response field type narrowed or changed: `string → number`, `string → string | null` (clients that didn't handle null).
- Enum value removed from a response enum, or a new value added to a request enum the server validates strictly.
- Status code mapping changed: `404 → 400` for the same input.
- Error code/shape changed: `{ code: "NOT_FOUND" }` → `{ error: "not_found" }`.
- Auth scope/role newly required on a previously-permissive endpoint.
- Pagination envelope changed: `{ items, total }` → `{ data, meta }`.
- SSE event renamed, webhook payload field removed, queue message version stays the same but shape changed.

## Not breaking (informational only)

- Adding a new endpoint.
- Adding an **optional** request field with a safe default.
- Adding a **new** response field that clients can ignore (the JSON superset rule — only true if clients are documented as ignoring unknowns).
- Loosening validation (accepting more inputs than before).
- Widening a response type from `string` → `string | null` is still breaking if clients didn't expect null. Widening a request type is usually safe.

## Examples

### BAD — silent field rename in response

```diff
// server/src/vendor/shared/contracts/user.ts
 export const UserDTO = z.object({
   id: z.string(),
-  fullName: z.string(),
+  displayName: z.string(),
   email: z.string().email(),
 })
```
**Verdict:** MUST. Every client reading `user.fullName` breaks at runtime. Fix: keep `fullName` as a deprecated alias for one minor version, add `displayName` alongside, schedule removal in the next major.

### BAD — required field added to request

```diff
 export const CreateUserRequest = z.object({
   email: z.string().email(),
   password: z.string().min(12),
+  acceptedTermsAt: z.string().datetime(),   // now required
 })
```
**Verdict:** MUST. Existing clients posting valid payloads now get 400. Fix: make it `.optional()` with a documented server-side default, or version the endpoint (`/v2/users`).

### GOOD — additive optional field

```diff
 export const CreateUserRequest = z.object({
   email: z.string().email(),
   password: z.string().min(12),
+  marketingOptIn: z.boolean().optional().default(false),
 })
```
**Verdict:** Not breaking. Old clients omit the field, server fills the default. Safe to ship as a minor bump.

### GOOD — new endpoint, no change to existing

```diff
+ fastify.get('/api/v1/users/:id/avatar', async (req) => { ... })
```
**Verdict:** Not breaking. Pure addition. Minor bump.

## Checklist before clearing a diff

- [ ] No removed/renamed endpoints, fields, enum values, or event names.
- [ ] No required fields added to existing requests.
- [ ] No response field types narrowed.
- [ ] No status code or error envelope changes for existing inputs.
- [ ] No new auth requirements on existing endpoints.
- [ ] If any of the above is intentional, it is behind a new versioned route AND the old route still works.
