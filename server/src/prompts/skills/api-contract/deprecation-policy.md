---
name: deprecation-policy
description: Requires @deprecated annotation before silent removal of API elements
type: rubric
---

# Deprecation Policy

Never silently remove a public route, parameter, or response field. Always annotate the element as deprecated first, then remove it in a subsequent major release.

## Bad

```diff
- router.get('/v1/users', legacyHandler)
```

Route deleted without prior deprecation notice. Clients get 404 with no warning.

## Good

```diff
  /**
+  * @deprecated — use GET /v2/users instead. Will be removed in v4.0.
   */
  router.get('/v1/users', legacyHandler)
```

Flag any diff that removes a public element without a prior `@deprecated` annotation or deprecation header in the response.
