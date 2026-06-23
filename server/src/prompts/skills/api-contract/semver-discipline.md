---
name: semver-discipline
description: Asserts that breaking API changes require a major version bump
type: rubric
---

# SemVer Discipline

Any breaking change to a public API contract requires a major version increment (MAJOR.minor.patch). Flag PRs that introduce breaking changes without a corresponding version bump in the version file or CHANGELOG.

## Bad

A PR that renames a response field or removes a route, with no changes to `package.json` version or `CHANGELOG.md`.

## Good

```diff
- "version": "2.4.1"
+ "version": "3.0.0"
```

With a CHANGELOG entry listing all breaking changes and migration instructions.

If a breaking change is found and no version bump is present, flag it as a blocker.
