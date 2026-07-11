---
description: Run the implement half of the SDD pipeline from a Development Plan — implement (multi/single), verify (gate), architecture-review, bounded fix loop. Does not commit.
---

Invoke the Workflow tool with `name: 'sdd'`, passing any provided plan path, spec path, designs, and extra requirements as args.

Report the returned summary: implemented tasks, plan-verifier verdicts, MUST/SHOULD review findings, fixes applied, and anything still unmet. Do not commit — hand back to the user.

Note: the first run of this command also serves as the live verification of `agentType` dispatch (documented in the harness but unused elsewhere in this repo).
