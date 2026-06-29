---
name: engineering-insights
description: Use when the agent has just discovered something non-obvious about the codebase that a future session would not re-derive from the code alone — a working pattern, a failed approach, a tool/library quirk, a recurring error and its fix, a design decision and its reason, or an open question. Also use when wrapping up a substantive task (>30 min, with a problem, decision, or discovery). Skip for trivial edits, renames, and anything obvious from reading the diff.
---

# Engineering Insights

Append concise, file-grounded lessons to a per-module `LEARNINGS.md` so future sessions start with the insight instead of re-deriving it. Every entry must add something a contributor reading the diff would not already know.

## When to use

- A working pattern, antipattern, gotcha, quirk, recurring error+fix, decision with reason, or open question surfaced during work.
- End of a substantive task (>30 min with a problem, decision, or discovery).
- The user invoked `/engineering-insights`.

## When NOT to use

- Trivial edits, renames, formatting, dependency bumps.
- Anything obvious from reading the diff. Apply the **anti-banality test**: if a contributor reading the change would already know it, do not write it.
- Status updates, PR descriptions, narration of what was done.

## Procedure

### 1. Pick the target file (auto-detect)

For each file touched this session, walk up to the nearest directory matching, in order:

1. A directory that contains an existing `LEARNINGS.md` → use it.
2. Else, a directory that contains its own `package.json` → create `LEARNINGS.md` there from `~/.claude/skills/engineering-insights/LEARNINGS-TEMPLATE.md`.
3. Else, the repo root (the directory containing `.git/`).

Group findings by target file. **One insight that affects two modules → two entries, one per file. Never a cross-module mega-entry.**

### 2. Draft entries (one per finding)

Each entry is one line, in a fixed shape:

```
- YYYY-MM-DD · <Category> · <one-sentence finding>. <path:line>. Reason: <why a future reader would not derive this from the diff>.
```

Categories: `What Works`, `What Doesn't Work`, `Codebase Patterns`, `Tool & Library Notes`, `Recurring Errors & Fixes`, `Decisions`, `Open Questions`.

Vague vs useful (from MindStudio):
- ❌ "Promises can be tricky."
- ✅ `- 2026-06-19 · Tool & Library Notes · Promise.all() on the ingest pipeline times out past ~30 items — use Promise.allSettled() in batches of 10. server/src/modules/repos/ingest.ts:142. Reason: GitHub rate-limit interacts with pgvector batch insert.`

### 3. Confirm with the user

Present the drafted entries grouped by target file. Ask yes/no per entry. **Never write without confirmation in manual mode.** Drop the ones the user rejects, append the ones they accept.

### 4. Append (never edit)

Add accepted entries under the matching category section. Add a dated bullet under `## Session Notes` only if the session itself is worth a one-line summary; skip otherwise.

If no findings survive the anti-banality test, output: **"No insights to capture."** and write nothing. Empty wrap-ups are a feature.

## Discipline — read this every time

**Violating the letter of these rules violates the spirit. No exceptions.**

- **Append-only.** Never edit, reorder, delete, or "tidy" existing entries. Not for typos. Not for duplicates. Not for outdated info. To correct a stale entry, append a new dated entry that supersedes it and names the entry it replaces.
- **Refuse to fabricate.** If nothing non-obvious happened, write nothing. Inventing filler poisons the file faster than missing entries do.
- **No diff restatement.** An entry must add a reason, a constraint, an invariant, an alternative that was rejected, or a gotcha — never just "we changed X to Y."
- **Per-module isolation.** Two modules → two entries. Never merge.
- **File-grounded.** Every entry cites `path:line` or `path:` (when whole-file). No floating claims.

## Rationalizations — STOP if you think this

| Excuse | Reality |
|---|---|
| "It's just a typo fix to an old entry." | Append a supersession. Never edit. |
| "These two entries are duplicates — let me consolidate." | Append-only. Duplicates are cheap; lost history is not. |
| "Nothing landed, but I should still write something." | No. Write "No insights to capture." |
| "The user will get more value if I add detail from the diff." | The diff is in git. The entry must add what the diff cannot. |
| "Cross-module insight, one merged entry is cleaner." | No. Two entries. |
| "I'm running headless / from a hook, I can skip confirmation." | If non-interactive, append only entries that pass the anti-banality test on their face; otherwise drop. Never invent. |

## Quick reference — category pick

| Category | Use for |
|---|---|
| What Works | Approach that solved a real problem, with the reason |
| What Doesn't Work | Approach that failed and why — antipattern, dead end |
| Codebase Patterns | Convention, architectural choice, invariant that spans files |
| Tool & Library Notes | Quirk of a dep, undocumented behavior, version trap |
| Recurring Errors & Fixes | Same error seen twice → record the fix once |
| Decisions | Architectural or design choice + reason + alternatives rejected |
| Open Questions | Known unknown worth resurfacing later |

## LEARNINGS.md template

When creating a new `LEARNINGS.md`, copy `~/.claude/skills/engineering-insights/LEARNINGS-TEMPLATE.md` and replace `<module-name>` with the directory name.

## Hygiene (not your job during capture)

- Length ceiling ~200 entries per file. Above that, the user splits the file by domain — not the skill's job.
- Quarterly prune is a manual review pass — not the skill's job.
- This skill never deletes. Pruning is a separate, user-initiated action.
