---
name: breaking-change
description: Flags removal or renaming of any public API contract element
type: rubric
---

# Breaking Change Detection

Flag any diff that removes, renames, or changes the HTTP method of a public route, or removes/renames a field in a public request or response body.

## Bad

```diff
- router.delete('/users/:id', handler)
+ router.delete('/accounts/:id', handler)
```

Route path renamed without backward-compatible alias. Existing clients break silently.

## Good

```diff
+ router.delete('/accounts/:id', handler)  // new path
+ router.delete('/users/:id', legacyRedirect)  // backward-compatible alias, deprecated
```

Cite the file:line of the removed or renamed element and explain which clients it breaks.
