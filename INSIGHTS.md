# Cross-cutting insights

For learnings scoped to a single package, write in that package's `INSIGHTS.md`.
This file is for things that touch more than one package, or describe project-level decisions.

## Entry format

Use this template:

    ## YYYY-MM-DD — short title
    Context: what we were doing
    What we tried: approaches considered or attempted
    What worked: the approach that landed
    Why it matters: what to remember next time

Append-only in spirit. Don't edit old entries; add a new one if the world changes.

---

## 2026-06-23 — Auto-trigger /engineering-insights via Stop hook

Context: wanted the skill at `.claude/skills/engineering-insights/` to fire automatically at session wrap-up instead of relying on memory.

What we tried:
- `SessionEnd` hook — Claude isn't running, can't actually invoke the skill.
- `Stop` hook with `prompt`/`agent` type — schema rejects: those hook types only work for `PreToolUse`/`PostToolUse`/`PermissionRequest`.
- Once-per-session blocking command hook — landed.

What worked: a `Stop` command hook (`.claude/hooks/engineering-insights-reminder.sh`) that emits `{"decision":"block","reason":"..."}` to feed a reminder back to Claude, gated by a `/tmp/claude-insights-fired-<session_id>` marker so it fires at most once per session.

Why it matters: future hook work — `Stop`/`SessionStart`/`UserPromptSubmit` can only use `command`/`http`/`mcp_tool` types; the LLM-judge variants (`prompt`, `agent`) are off-limits. And `decision: "block"` is the documented path to push context back into Claude from a Stop hook.

## 2026-06-23 — Use `git status --porcelain` for "is the working tree dirty?"

Context: writing the engineering-insights Stop hook's "substantive work" detector.

What we tried: `git diff --quiet || git diff --cached --quiet` as the trigger check.

What worked: `[ -n "$(git status --porcelain)" ]`.

Why it matters: `git diff` inspects only tracked-file changes — adding new files (the common case for hook authoring, skill files, docs) leaves the diff empty and the trigger silent. Any heuristic that means "did anything change?" must use `git status --porcelain` (or `git ls-files --others --exclude-standard` to scope to untracked).

## 2026-06-23 — Pair Claude Code skill copies with hooks in the committed `.claude/settings.json`

Context: copied the engineering-insights skill into the project and added a Stop hook to auto-trigger it.

What we tried: considered putting the hook in `.claude/settings.local.json` (gitignored, personal-only).

What worked: hook in `.claude/settings.json` (committed). Skill copy under `.claude/skills/engineering-insights/` is also committed.

Why it matters: hook and skill ship together — a teammate cloning the repo gets the skill but the automation that triggers it would otherwise live in personal config they don't have. Pair both in the committed file. Reserve `settings.local.json` for personal allow-lists / workflow tweaks.
