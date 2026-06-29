---
description: Run a second-pass architectural review of the uncommitted diff (client/ + server/) before claiming work ready.
---

Invoke the Workflow tool with `name: 'pr-self-review'`. After it returns:

1. If `skipped: true`, report "No changes in client/ or server/ — nothing to review." and stop.
2. If `partial: true`, name which side failed and stop without claiming pass/fail.
3. List `must` findings as blockers (each: rule id, file:line, why, fix_hint). For each MUST, propose a concrete fix and ask before applying — per the global "ask before risky actions" rule.
4. List `should` findings as advisories.
5. Final line: a one-sentence verdict — "READY" if `must` is empty and `partial` is false; "BLOCKED — N MUST findings" otherwise.
