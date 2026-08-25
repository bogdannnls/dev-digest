#!/usr/bin/env bash
# PreToolUse hook: deterministic gate on `git commit`.
#
# This is the deterministic counterpart to the eval-pipeline's probabilistic
# gate — see docs/features/2026-08-25-eval-pipeline/hook-gate.md. Whether the
# fast test lanes are currently green is a binary, reproducible fact, not a
# judgment call, so it belongs behind a hook (deterministic, no LLM in the
# loop) rather than an eval (probabilistic, measures a judgment).
#
# Fires only when the Bash command about to run IS a `git commit` invocation.
# Everything else — `git status`, `git diff`, `npm`/`pnpm` scripts, or a
# command that merely mentions "git commit" inside an unrelated string (an
# echo, a `--grep` argument, a comment) — passes through untouched: exit 0,
# no output, no side effects.
#
# When it does fire, it runs the FAST lanes only:
#   - server unit tests, no Docker:  cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'
#   - client tests:                  cd client && pnpm test
# It deliberately does NOT run the server's full `pnpm test`, which pulls in
# `*.it.test.ts` (needs Docker via testcontainers, ~25s, and — as of this
# writing — has two pre-existing failures in
# server/test/settings-models.it.test.ts unrelated to this gate, being fixed
# in a separate session). A gate wired to the full suite would block every
# commit in the repository, including the one that fixes those tests.
#
# On failure, emits the PreToolUse deny decision (verified against the
# installed Claude Code binary's self-documented hook JSON schema — see
# hook-gate.md) with a message naming which lane failed, a tail of the actual
# failure output, and the exact command to reproduce it locally.

set -u

input="$(cat)"

tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"
[ "$tool_name" != "Bash" ] && exit 0

command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -z "$command" ] && exit 0

# Split the command on shell control operators (&&, ||, ;, |, newline) so we
# only match a segment that IS a `git commit` invocation — not one that
# merely contains the text "git commit" as a substring of an unrelated
# command (e.g. inside an echo string or a `git log --grep` argument).
is_git_commit=0
while IFS= read -r segment; do
  trimmed="$(printf '%s' "$segment" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  # Anchor on the start of the segment and require whitespace-or-end right
  # after "commit" so `git commit-tree` etc. don't false-positive.
  if printf '%s' "$trimmed" | grep -qE '^git[[:space:]]+commit([[:space:]]|$)'; then
    is_git_commit=1
    break
  fi
done < <(printf '%s\n' "$command" | sed -E 's/(&&|\|\||;|\|)/\n/g')

[ "$is_git_commit" -eq 0 ] && exit 0

repo_root="${CLAUDE_PROJECT_DIR:-}"
[ -z "$repo_root" ] && repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$repo_root" ] && exit 0

deny() {
  lane="$1"
  repro="$2"
  out="$3"
  tail_out="$(printf '%s' "$out" | tail -n 20)"
  jq -n \
    --arg lane "$lane" \
    --arg repro "$repro" \
    --arg tail "$tail_out" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ("Commit blocked: the " + $lane + " fast test lane is red.\nReproduce with: " + $repro + "\n\nLast output:\n" + $tail)
      }
    }'
  exit 0
}

server_out="$(cd "$repo_root/server" && pnpm exec vitest run --exclude '**/*.it.test.ts' 2>&1)"
server_status=$?
if [ "$server_status" -ne 0 ]; then
  deny "server unit" "cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'" "$server_out"
fi

client_out="$(cd "$repo_root/client" && pnpm test 2>&1)"
client_status=$?
if [ "$client_status" -ne 0 ]; then
  deny "client" "cd client && pnpm test" "$client_out"
fi

exit 0
