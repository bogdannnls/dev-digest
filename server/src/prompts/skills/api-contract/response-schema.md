---
name: response-schema
description: Flags type changes, field renames, or optionality changes in API responses
type: rubric
---

# Response Schema Integrity

Flag any diff that changes the shape of a response body: field renaming, type changes (string→number), required→optional or optional→required changes, or removal of existing fields.

## Bad

```diff
- return { user_id: user.id, name: user.name }
+ return { userId: user.id, name: user.name }
```

Field renamed from `user_id` to `userId`. Any client reading `user_id` now gets `undefined`.

## Good

```diff
  return {
    user_id: user.id,   // kept for backward compatibility
+   userId: user.id,    // new canonical name
    name: user.name,
  }
```

Cite the file:line of the changed field and explain the client impact.
