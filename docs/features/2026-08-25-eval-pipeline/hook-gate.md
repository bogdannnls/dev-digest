# Deterministic pre-commit test gate

## Reliability-ladder placement

This is a **critical invariant**, not a judgment call: "are the fast test lanes
currently green?" has one correct, reproducible answer given the working
tree, with no model interpretation involved. That is exactly what a **hook**
should enforce — deterministic, no LLM in the loop — rather than an eval,
which is the right instrument for judgment calls that only have a
probabilistic quality signal (e.g. "is this review comment useful?").

## What it does

`.claude/hooks/pre-commit-test-gate.sh`, wired as a `PreToolUse` hook
(matcher `Bash`) in `.claude/settings.json`:

1. Reads the pending Bash command from the hook's stdin JSON
   (`.tool_input.command`).
2. Splits it on shell control operators (`&&`, `||`, `;`, `|`, newline) and
   checks whether any resulting segment **is** a `git commit` invocation
   (`^git[[:space:]]+commit([[:space:]]|$)`, anchored so `git commit-tree`
   doesn't false-positive). Anything else — `git status`, `git diff`, `npm`
   scripts, or a command that merely mentions "git commit" inside an
   unrelated string — returns immediately with no output and exit 0.
3. On a match, runs the two FAST lanes only:
   - `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'`
   - `cd client && pnpm test`
4. If either lane fails, emits the `PreToolUse` deny decision and blocks the
   commit; if both pass, exits 0 silently and the commit proceeds.

It deliberately does **not** run the server's full `pnpm test`. That target
also runs `*.it.test.ts` (needs Docker via testcontainers, ~25s) and, as of
this writing, has two pre-existing failures in
`server/test/settings-models.it.test.ts` unrelated to this gate (being fixed
in a separate session — confirmed below). A gate wired to the full suite
would block every commit in the repo, including the one that fixes those
tests.

## Deny JSON shape

Verified against the installed Claude Code binary's own embedded schema
documentation (`strings` on the binary at
`~/.local/share/claude/versions/2.1.234`, since no network/docs access was
available in this session):

```
hookSpecificOutput: {
  "for PreToolUse": {
    hookEventName: "PreToolUse",
    permissionDecision: "allow" | "deny" | "ask" | "defer" (optional),
    permissionDecisionReason: string (optional),
    updatedInput: object (optional)
  }
}
```

and the internal permission-resolution code path confirms `permissionDecision:
"deny"` short-circuits the tool call with `Permission denied for <tool>:
<message>`. The hook emits:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Commit blocked: the <lane> fast test lane is red.\nReproduce with: <command>\n\nLast output:\n<tail of actual failure>"
  }
}
```

The same `strings` search confirmed hook `timeout` is in **seconds** ("Timeout
in seconds for this specific command"), matching the existing `Stop` hook's
`"timeout": 10` — the new `PreToolUse` entry uses `"timeout": 90` to leave
headroom over the ~7-9s observed run time for both lanes together.

## Verification

**Caveat, stated plainly:** this session could not trigger the hook through
the live end-to-end pipeline. Two independent constraints ruled it out: (a)
`.claude/settings.json` is read by Claude Code at session start, and this
hook was added mid-session, so this session's own tool calls do not go
through it; (b) this implementer's own tool permissions do not include
`git commit` in any form (only read-only `git status`/`diff`/`log`/`show`/
`blame` are allowed), so a live `git commit` attempt was never issuable
regardless of (a). All three checks below were therefore done by invoking
`pre-commit-test-gate.sh` directly with a crafted stdin payload, matching the
hook's actual JSON contract byte-for-byte with what Claude Code sends.

Before wiring the gate, the claimed baseline was verified directly (not
assumed):

```
$ cd server && pnpm test
...
Test Files  1 failed | 68 passed (69)
     Tests  2 failed | 558 passed (560)
  Duration  26.16s
```
Two failures, both in `test/settings-models.it.test.ts`, both pre-existing
(unrelated assertions about default model registry and secrets-status
shape) — confirms the full-suite gate would have blocked commits and why the
gate targets the two fast lanes instead.

Fast-lane baseline, both green:
```
$ cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'
Test Files  44 passed (44) / Tests 386 passed (386) — 2.16s
$ cd client && pnpm test
Test Files  50 passed (50) / Tests 222 passed (222) — 5.03s
```

### 1. Blocks on a red lane

Created `server/test/scratch-hook-gate-verify.test.ts` with a deliberately
failing assertion (`expect(1).toBe(2)`), then ran:

```
$ printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"test commit\""}}' \
    | CLAUDE_PROJECT_DIR=/Users/pandpbsa/Projects/dev-digest bash .claude/hooks/pre-commit-test-gate.sh
```

Observed output:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Commit blocked: the server unit fast test lane is red.\nReproduce with: cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'\n\nLast output:\n- Expected\n+ Received\n\n- 2\n+ 1\n\n ❯ test/scratch-hook-gate-verify.test.ts:5:15\n ...\n Test Files  1 failed | 44 passed (45)\n      Tests  1 failed | 386 passed (387)"
  }
}
```
The scratch file was deleted immediately after (`rm
server/test/scratch-hook-gate-verify.test.ts`); `git status --porcelain`
afterward shows no trace of it.

### 2. Passes on green lanes

Same payload, scratch file removed, lanes green:
```
$ printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"test commit\""}}' \
    | CLAUDE_PROJECT_DIR=/Users/pandpbsa/Projects/dev-digest bash .claude/hooks/pre-commit-test-gate.sh
```
No stdout, exit 0, ~7.4s wall time. Also verified with a multi-segment
command (`cd server && git commit -m "test commit"`): no stdout, exit 0,
~9.0s wall time.

### 3. Does not over-fire

```
$ printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | bash .claude/hooks/pre-commit-test-gate.sh
# no output, exit 0
$ printf '%s' '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | bash .claude/hooks/pre-commit-test-gate.sh
# no output, exit 0
$ printf '%s' '{"tool_name":"Bash","tool_input":{"command":"echo \"remember to git commit later\""}}' | bash .claude/hooks/pre-commit-test-gate.sh
# no output, exit 0 — commit-adjacent string inside an unrelated command is untouched
$ printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit-tree HEAD^{tree}"}}' | bash .claude/hooks/pre-commit-test-gate.sh
# no output, exit 0 — word-boundary guard rejects the commit-tree subcommand
$ printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x","content":"git commit -m x"}}' | bash .claude/hooks/pre-commit-test-gate.sh
# no output, exit 0, ~8ms — non-Bash tool calls short-circuit before any parsing
```
All five ran in under 15ms each except where noted, confirming the gate does
not run the test lanes unless the command is actually a `git commit`
invocation.

## Re-verification requested by coordinator (post-report)

A QA pass flagged the same trailing-newline bug described above and asked
for the fix to be re-verified empirically, including a case not covered by
name in the original writeup: a **chained** command that *ends* in
`git commit`. This section is that re-verification, run after the fix was
already in place (the fix landed before the QA message arrived — see "A bug
this verification caught" below) — every result here is freshly executed,
not copied from the earlier section.

**Coordinator's exact repro, re-run against the current (fixed) script:**
```
$ echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' | bash .claude/hooks/pre-commit-test-gate.sh; echo $?
exit=0   (but see timing below — exit 0 alone doesn't distinguish "caught and green" from "never caught")
```
Distinguishing the two requires timing, since both produce exit 0 and no
stdout when the lanes are green:
```
$ time (echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' \
    | CLAUDE_PROJECT_DIR=/Users/pandpbsa/Projects/dev-digest bash .claude/hooks/pre-commit-test-gate.sh)
9.620s total, exit=0
```
9.6s of real work (both test lanes actually ran) rules out the ~16ms
structural no-op the QA pass reproduced against the pre-fix draft.

**Check 4 (new) — chained command ending in `git commit`, `bash -x` trace:**
```
$ echo '{"tool_name":"Bash","tool_input":{"command":"git status && git commit -m test"}}' | bash -x .claude/hooks/pre-commit-test-gate.sh
+ read -r segment
++ printf '%s\n' 'git status && git commit -m test'
++ sed -E 's/(&&|\|\||;|\|)/\n/g'
...
+ grep -qE '^git[[:space:]]+commit([[:space:]]|$)'
+ IFS=
+ read -r segment
++ printf %s ' git commit -m test'
++ sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
...
+ grep -qE '^git[[:space:]]+commit([[:space:]]|$)'
+ is_git_commit=1
+ break
+ '[' 1 -eq 0 ']'
```
The trace shows the loop reads the first segment (`git status`, no match),
then reads the second/last segment (` git commit -m test`), matches it, sets
`is_git_commit=1`, and breaks — the exact segment the pre-fix bug dropped is
reached and caught.

**Check 4, functional — chained-ending case, red lane:**
Recreated `server/test/scratch-hook-gate-verify.test.ts` (same failing
assertion as check 1), ran:
```
$ echo '{"tool_name":"Bash","tool_input":{"command":"git status && git commit -m test"}}' \
    | CLAUDE_PROJECT_DIR=/Users/pandpbsa/Projects/dev-digest bash .claude/hooks/pre-commit-test-gate.sh
```
Output:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Commit blocked: the server unit fast test lane is red.\nReproduce with: cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'\n\nLast output:\n- Expected\n+ Received\n\n- 2\n+ 1\n\n ❯ test/scratch-hook-gate-verify.test.ts:5:15\n ...\n Test Files  1 failed | 44 passed (45)\n      Tests  1 failed | 386 passed (387)\n   Start at  16:48:22"
  }
}
```
Scratch file deleted immediately after; `git status --porcelain` showed 0
matches for `scratch` afterward.

**Check 4, functional — chained-ending case, green lanes:**
```
$ time (echo '{"tool_name":"Bash","tool_input":{"command":"git status && git commit -m test"}}' \
    | CLAUDE_PROJECT_DIR=/Users/pandpbsa/Projects/dev-digest bash .claude/hooks/pre-commit-test-gate.sh)
8.859s total, exit=0, no stdout
```

**Checks 1–3, re-confirmed fresh (not reused from the earlier section):**
- Check 1 (block, red lane, plain `git commit -m test`): denied, same shape
  as check 1 above, `Start at 16:47:48`, `Duration 2.09s`, scratch file
  removed immediately after, 0 matches remaining.
- Check 2 (pass, green lanes, plain `git commit -m test`): `9.891s total`,
  exit 0, no stdout.
- Check 3 (non-commit commands untouched): `git status` — `0.018s total`,
  exit 0, no stdout; `npm test` — `0.017s total`, exit 0, no stdout. Both
  orders of magnitude faster than a real test-lane run, confirming neither
  ran the lanes.

Net: the fix (`printf '%s\n' "$command"` before the `sed` split, described
below) holds for the plain-commit case, the chained-ending-in-commit case
called out by QA, and does not regress the non-fire cases.

## A bug this verification caught

The first draft split the command into segments with
`printf '%s' "$command" | sed ...` (no trailing newline) feeding a
`while IFS= read -r segment; do ... done < <(...)`. On this machine's `bash`
(3.2.57, macOS's frozen pre-GPLv3 system bash), a `read` on a final segment
with **no trailing newline** returns non-zero, so the `while` loop's body
never executes for that segment — silently. That is precisely the common
case: a plain `git commit -m "..."` with no `&&`/`;`/`|` produces exactly one
segment with no trailing newline, so the very case this hook exists to catch
was silently skipped. Fixed by changing the split to
`printf '%s\n' "$command" | sed ...` (trailing newline added before
splitting). Caught by test 2b above failing to reproduce test 1's deny
before the fix — worth an `INSIGHTS.md` entry given how quietly it fails (no
error, no stderr, just an unfired gate).
