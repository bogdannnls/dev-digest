#!/usr/bin/env bash
# Stop hook: nudge Claude to run the engineering-insights skill once per
# session, only when the working tree shows substantive activity.
#
# Trigger condition (any of):
#   * uncommitted changes in the working tree, OR
#   * at least one commit in the last 2 hours.
#
# Fires at most once per session via a marker in /tmp keyed by session_id.
# The reminder is injected through `decision: "block"`, which feeds the
# reason back to Claude and lets the turn continue with the nudge in view.

set -euo pipefail

input="$(cat)"

session_id="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)"
[ -z "$session_id" ] && exit 0

marker="/tmp/claude-insights-fired-${session_id}"
[ -f "$marker" ] && exit 0

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$repo_root" ] && exit 0
cd "$repo_root"

has_work=0
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  has_work=1
elif [ -n "$(git log --since='2 hours ago' --oneline 2>/dev/null)" ]; then
  has_work=1
fi

[ "$has_work" -eq 0 ] && exit 0

touch "$marker"

cat <<'JSON'
{
  "decision": "block",
  "reason": "Before stopping: if this session involved a substantive task (a problem solved, a decision made, or a non-obvious discovery), invoke the engineering-insights skill now to capture learnings into LEARNINGS.md. Skip for trivial edits, renames, formatting, or anything obvious from the diff."
}
JSON
